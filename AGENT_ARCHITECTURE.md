# Alex 多代理架構流程整理

> 本文件根據 `backend/` 下實際程式碼整理，對應講師對 Agent 架構的講解。
> 重點：每個 Agent 都用 **OpenAI Agents SDK** + **LiteLLM → Bedrock**，且因為 LiteLLM/Bedrock 的限制，
> **同一個 Agent 不能同時使用 Structured Outputs 與 Tools**，所以每個 Agent 只會選其中一種（或都不用）。

---

## 0. 共通基礎：如何連接 Bedrock

所有 Agent 的 `create_agent()` 都用同一套寫法連到 Bedrock：

```python
from agents.extensions.models.litellm_model import LitellmModel

model_id = os.getenv("BEDROCK_MODEL_ID", "...")
bedrock_region = os.getenv("BEDROCK_REGION", "us-west-2")

# ⚠️ 關鍵：LiteLLM 讀的是 AWS_REGION_NAME，不是 AWS_REGION
os.environ["AWS_REGION_NAME"] = bedrock_region

model = LitellmModel(model=f"bedrock/{model_id}")
```

- `bedrock/{model_id}` 這個前綴是 LiteLLM 用來辨識「要走 Bedrock」的標準寫法。
- `AWS_REGION_NAME` 是最容易踩坑的地方：其他 AWS 服務可能用 `AWS_REGION` 或 `DEFAULT_AWS_REGION`，
  但 LiteLLM Bedrock 一定要 `AWS_REGION_NAME`（見 LiteLLM 官方文件）。

每個 Agent 的標準 Lambda 執行骨架：

```python
with trace("XXX Agent"):
    agent = Agent(name=..., instructions=..., model=model, tools=...)
    result = await Runner.run(agent, input=task, max_turns=...)
    response = result.final_output
```

---

## 1. 五個 Agent 一覽表

| Agent | 目錄 | 用 Tools？ | 用 Structured Output？ | 用 Context？ | 部署形態 | 觸發來源 |
|---|---|:---:|:---:|:---:|---|---|
| **Planner**（協調者） | `backend/planner` | ✅ 3 個 function tool | ❌ | ✅ `PlannerContext` | Lambda | SQS |
| **Tagger**（分類） | `backend/tagger` | ❌ | ✅ `InstrumentClassification` | ❌ | Lambda | Planner 用程式碼呼叫 |
| **Reporter**（報告） | `backend/reporter` | ✅ 1 個 tool | ❌ | ✅ `ReporterContext` | Lambda | Planner 用 tool 呼叫 |
| **Charter**（圖表） | `backend/charter` | ❌ | ❌（純文字輸出 JSON） | ❌ | Lambda | Planner 用 tool 呼叫 |
| **Retirement**（退休） | `backend/retirement` | ❌（空 list） | ❌ | ❌ | Lambda | Planner 用 tool 呼叫 |

> 講師重點：Charter 與 Retirement 是「最簡單」的 Agent，當初 Claude Code 把它們過度設計（加了 tools + structured outputs + 複雜邏輯），
> 後來被砍回到「只有 instructions + model」的最簡形態，反而更穩定可靠。

---

## 2. 整體流程圖

```
使用者請求
   │
   ▼
SQS Queue ──► Planner Lambda (run_orchestrator)
                │
                │ (1) 非 Agent 的純 Python 預處理 ──────────────┐
                │     handle_missing_instruments(job_id, db)     │  ← 程式碼編排 (workflow)
                │       └─► 找出缺 allocation 的 instrument        │
                │           └─► 直接 invoke Tagger Lambda ────────┼──► Tagger Agent
                │     update_instrument_prices(job_id, db)        │     (Structured Output)
                │     load_portfolio_summary(job_id, db)          │
                │                                                 ┘
                │ (2) 自主編排 (autonomous) ─ Runner.run + tools
                ▼
         Planner Agent（拿著 3 個 tool，自己決定要呼叫誰）
                ├─ invoke_reporter  ──► Reporter Lambda  ──► Reporter Agent (Tool: get_market_insights → S3 Vectors)
                ├─ invoke_charter   ──► Charter  Lambda  ──► Charter  Agent (純文字輸出 JSON 圖表)
                └─ invoke_retirement──► Retirement Lambda──► Retirement Agent (Monte Carlo + 文字分析)
                │
                ▼
         各 Agent 把結果寫回資料庫 (db.jobs.update_xxx)
                │
                ▼
         Planner 標記 job = "completed"
```

**兩種編排方式的對比（講師最強調的觀念）：**

- **程式碼編排（Agentic Workflow）**：Tagger 的觸發。「找出缺資料的 instrument → 逐一分類」是個明確的迴圈，
  本來就該用 Python 寫，所以放在 `Runner.run` **之外**，由 `handle_missing_instruments()` 直接呼叫 Tagger Lambda。
- **自主編排（Autonomous / Agentic）**：Reporter / Charter / Retirement 的觸發。要不要呼叫、呼叫哪些，
  交給 Planner Agent 透過 tools 自己決定。

> 這就是為什麼 Planner 只掛 3 個 tool（reporter/charter/retirement），而沒有 tagger —— tagger 不是由 LLM 決定的。

---

## 3. 各 Agent 詳解

### 3.1 Planner（協調者）— 使用 Tools + Context

**檔案**：`backend/planner/agent.py`、`lambda_handler.py`

- **觸發**：SQS 訊息，body 是 `job_id`（`lambda_handler` 解析 `event['Records'][0]['body']`）。
- **執行順序**（`run_orchestrator`）：
  1. `db.jobs.update_status(job_id, 'running')`
  2. `handle_missing_instruments()` → 純 Python，必要時 invoke Tagger
  3. `update_instrument_prices()` → 補上價格
  4. `load_portfolio_summary()` → 只取統計摘要（不取完整資料，省 token）
  5. 建立 Agent 並 `Runner.run(...)`，由 LLM 決定呼叫哪些子 Agent
  6. `db.jobs.update_status(job_id, "completed")`

- **Tools**（用 `@function_tool` 裝飾）：

```python
tools = [invoke_reporter, invoke_charter, invoke_retirement]
```

  每個 tool 內部呼叫對應的 Lambda（`invoke_lambda_agent` → `lambda_client.invoke`）。

- **Context 傳遞（講師說的「pro 寫法」）**：用 `RunContextWrapper` 取代 global 變數，把 `job_id` 乾淨地傳進每個 tool：

```python
@dataclass
class PlannerContext:
    job_id: str

agent = Agent[PlannerContext](name="Financial Planner", ..., tools=tools)
result = await Runner.run(agent, input=task, context=context, max_turns=20)

@function_tool
async def invoke_reporter(wrapper: RunContextWrapper[PlannerContext]) -> str:
    return await invoke_reporter_internal(wrapper.context.job_id)
```

  好處：每個 tool 都能知道目前在處理哪個 `job_id`，又不需要用 global（講師原本被 Claude Code 用 global 實作，後來改成這個 SDK 推薦的乾淨做法）。

- **本機測試**：`MOCK_LAMBDAS=true` 時，`invoke_lambda_agent` 不會真的呼叫 Lambda，只回傳 mock 結果。

- **Prompt（`planner/templates.py`）**：`ORCHESTRATOR_INSTRUCTIONS` 極短，刻意把判斷規則寫死，避免 LLM 亂呼叫工具：

```
You coordinate portfolio analysis by calling other agents.

Tools (use ONLY these three):
- invoke_reporter: Generates analysis text
- invoke_charter: Creates charts
- invoke_retirement: Calculates retirement projections

Steps:
1. Call invoke_reporter if positions > 0
2. Call invoke_charter if positions >= 2
3. Call invoke_retirement if retirement goals exist
4. Respond with "Done"

Use ONLY the three tools above.
```

  > 注意 prompt 裡只列三個 tool、明確規定條件（positions > 0、>= 2…），再三強調「ONLY these three」——
  > 因為 tagger 的觸發不歸 LLM 管，所以 prompt 完全不提 tagger。

---

### 3.2 Tagger（分類）— 使用 Structured Output

**檔案**：`backend/tagger/agent.py`、`lambda_handler.py`

- **觸發**：被 Planner 用程式碼直接 invoke（event 帶 `instruments` 清單），**不是**由 LLM 決定。
- **核心**：用 Pydantic 模型 `InstrumentClassification` 當 `output_type`，強迫模型輸出符合 schema 的結構化資料：

```python
agent = Agent(
    name="InstrumentTagger",
    instructions=TAGGER_INSTRUCTIONS,
    model=model,
    tools=[],                              # 不用 tools
    output_type=InstrumentClassification,  # ← structured output
)
result = await Runner.run(agent, input=task, max_turns=5)
return result.final_output_as(InstrumentClassification)
```

- **Schema 重點**：`InstrumentClassification` 包含三組 allocation（asset class / regions / sectors），
  且每組都有 `@field_validator` 驗證百分比加總 ≈ 100。這讓 LLM 自動把金融商品標好分類。
- **可選的進階作法（講師提到的 "pro move"）**：可掛上 Polygon.io 的 MCP server 讓它查真實資料，
  讓分類依據即時、準確的持股與價格，而不是靠模型記憶。目前單純靠 Nova 的知識做分類。
  > 補充：講師當初講解時 Researcher 還部署在 App Runner，因此提到「要跑 MCP server 得改用 App Runner」。
  > 但本專案已透過 PR #39（`researcher_as_lambda`）把 Researcher 遷到 **Lambda + Playwright MCP**，
  > 證明 MCP server 也能直接跑在 Lambda 裡，所以這個進階作法不一定需要 App Runner。

- **Prompt（`tagger/templates.py`）**：分成兩段。`TAGGER_INSTRUCTIONS` 定義角色與規則（含實際範例），
  `CLASSIFICATION_PROMPT` 是每個 instrument 的具體任務模板（用 `.format(symbol, name, instrument_type)` 填值）：

  `TAGGER_INSTRUCTIONS`（節錄重點）：
```
You are an expert financial instrument classifier ...

1. Current market price per share in USD
2. Exact allocation percentages for:
   - Asset classes (equity, fixed_income, real_estate, commodities, cash, alternatives)
   - Regions (north_america, europe, asia, etc.)
   - Sectors (technology, healthcare, financials, etc.)

Important rules:
- Each allocation category MUST sum to exactly 100.0
- For ETFs, consider the underlying holdings
- For individual stocks, allocate 100% to the appropriate categories

Examples:
- SPY (S&P 500 ETF): 100% equity, 100% north_america, distributed across sectors ...
- BND (Bond ETF): 100% fixed_income, 100% north_america, split treasury/corporate
- AAPL (Apple stock): 100% equity, 100% north_america, 100% technology
...
You must return your response as a structured InstrumentClassification object ...
```

  `CLASSIFICATION_PROMPT`（每筆商品的任務）：
```
Classify the following financial instrument:

Symbol: {symbol}
Name: {name}
Type: {instrument_type}

Provide:
1. Current price per share in USD (approximate market price ...)
2. Accurate allocation percentages for:
   1. Asset classes (...)
   2. Regions (...)
   3. Sectors (...)

Remember:
- Each category must sum to exactly 100.0%
- For stocks, typically 100% in one asset class, one region, one sector
- For ETFs, distribute based on underlying holdings
- For bonds/bond funds, use fixed_income asset class ...
```

  > Prompt 裡反覆要求「sum to exactly 100.0」，正好對應程式碼裡 Pydantic 的 `@field_validator` 雙重把關。

---

### 3.3 Reporter（報告）— 使用 Tool + Context

**檔案**：`backend/reporter/agent.py`、`lambda_handler.py`

- **觸發**：Planner 的 `invoke_reporter` tool → invoke Reporter Lambda。
- **唯一的 Tool**：`get_market_insights` —— 這是**連接上週與本週成果的關鍵點**。
  它去查 **S3 Vectors**（`researcher` 持續寫入的市場研究），流程：

```
symbols → SageMaker embedding endpoint 取得向量
        → s3vectors.query_vectors(index="financial-research", topK=3)
        → 回傳最相關的市場 insight 文字
```

- **Context**：用 `ReporterContext`（含 `job_id`、`portfolio_data`、`user_data`、`db`），同樣透過 `RunContextWrapper` 傳給 tool：

```python
agent = Agent[ReporterContext](name="Report Writer", ..., tools=[get_market_insights])
result = await Runner.run(agent, input=task, context=context, max_turns=10)
```

- **額外特色**：跑完後有 `judge`（LLM 評分），分數太低時直接擋掉回覆（guardrail），結果寫入 `db.jobs.update_report`。

- **Prompt（`reporter/templates.py`）**：`REPORTER_INSTRUCTIONS` 規定先用 tool 取得市場資訊，再產出固定結構的 markdown 報告：

```
You are a Report Writer Agent specializing in portfolio analysis ...

You have access to this tool:
1. get_market_insights - Retrieve relevant market context for specific symbols

Your workflow:
1. First, analyze the portfolio data provided
2. Use get_market_insights to get relevant market context for the holdings
3. Generate a comprehensive analysis report in markdown format covering:
   - Executive Summary (3-4 key points)
   - Portfolio Composition Analysis
   - Diversification Assessment
   - Risk Profile Evaluation
   - Retirement Readiness
   - Specific Recommendations (5-7 actionable items)
   - Conclusion
4. Respond with your complete analysis in clear markdown format.

Report Guidelines:
- Write in clear, professional language accessible to retail investors
- Use markdown formatting with headers, bullets, and emphasis
- Include specific percentages and numbers where relevant
- Focus on actionable insights, not just observations
- Prioritize recommendations by impact
```

  > workflow 第 2 步明確要求呼叫 `get_market_insights`，這就是把「上週的 researcher → S3 Vectors」接進報告的觸發點。

---

### 3.4 Charter（圖表）— 不用 Tools、不用 Structured Output

**檔案**：`backend/charter/agent.py`、`lambda_handler.py`

- **觸發**：Planner 的 `invoke_charter` tool。
- **最簡單的 Agent**：`create_agent()` 只回傳 `model` 和 `task`，沒有 tools、沒有 context、沒有 output_type：

```python
agent = Agent(name="Chart Maker", instructions=CHARTER_INSTRUCTIONS, model=model)
result = await Runner.run(agent, input=task, max_turns=5)  # 期待一次就吐出 JSON
output = result.final_output
```

- **重點作法**：把投資組合的計算（總值、各帳戶、asset class / region / sector 加總）全部用 **Python 先算好**
  （`analyze_portfolio()`），把結果塞進 prompt，讓 Agent **只負責產生 JSON 格式的圖表描述**。
- Lambda handler 再從文字輸出中用 `find('{')` / `rfind('}')` 抓出 JSON、`json.loads` 解析後存進資料庫。
- **講師教訓**：Claude Code 原本把這個過度設計成又有 tools 又有 structured output 的複雜怪物，
  砍回「instructions + model 產生 JSON」後反而簡單又可靠。

- **Prompt（`charter/templates.py`）**：因為沒用 structured output，所以靠 prompt **嚴格規定只輸出 JSON**，
  並附上完整的 JSON 範例（4-6 張圖）讓模型照抄格式。`CHARTER_INSTRUCTIONS`（節錄）：

```
You are a Chart Maker Agent that creates visualization data ...

You must output ONLY valid JSON in the exact format shown below.
Do not include any text before or after the JSON.

REQUIRED JSON FORMAT:
{
  "charts": [
    { "key": "asset_class_distribution", "title": "...", "type": "pie",
      "description": "...",
      "data": [ {"name": "Equity", "value": 146365.00, "color": "#3B82F6"}, ... ] }
  ]
}

IMPORTANT RULES:
1. Output ONLY the JSON object, nothing else
2. Each chart must have: key, title, type, description, and data array
3. Chart types: 'pie', 'bar', 'donut', or 'horizontalBar'
4. Values must be dollar amounts (not percentages - Recharts calculates those)
5. Colors must be hex format like '#3B82F6'
6. Create 4-6 different charts from different perspectives

CHART IDEAS TO IMPLEMENT:
- Asset class distribution / Geographic exposure / Sector breakdown
- Account type allocation / Top holdings concentration / Tax efficiency
```

  task 模板 `create_charter_task()` 則只塞「Python 已算好的 `portfolio_analysis` 文字」而非原始資料（省 token），結尾再次強調 `OUTPUT ONLY THE JSON OBJECT`。

  > 重點：規則 4「value 用金額不用百分比，由前端 Recharts 自己算百分比」，與規則 1/結尾反覆強調「只輸出 JSON」，
  > 正好對應 lambda handler 用 `find('{')`/`rfind('}')` 抓 JSON 的解析方式。

---

### 3.5 Retirement（退休規劃）— 不用 Tools、不用 Structured Output

**檔案**：`backend/retirement/agent.py`、`lambda_handler.py`

- **觸發**：Planner 的 `invoke_retirement` tool。
- **大量前置計算（純 Python）**：在 `create_agent()` 裡先算：
  - `calculate_portfolio_value()`、`calculate_asset_allocation()`
  - `run_monte_carlo_simulation()`（500 次模擬：累積期 + 退休提領期，算成功率、各百分位）
  - `generate_projections()`（每 5 年的里程碑）
- 把這些模擬結果**全部寫進 task（context 文字）**，Agent 本身極簡：

```python
tools = []  # 明確的空 list
agent = Agent(name="Retirement Specialist", instructions=..., model=model, tools=tools)
result = await Runner.run(agent, input=task, max_turns=20)
```

- **講師關鍵問句**：*「如果資料一定都在 context 裡，為什麼還要做一個 tool 去拿那份一定會用到的資料？」*
  答案是「不需要」—— 所以原本 Claude Code 加的「呼叫 Monte Carlo 的 tool」被移除，模擬結果直接放進 context。

- **Prompt（`retirement/templates.py`）**：實際使用的是 `RETIREMENT_INSTRUCTIONS`（定義角色與分析面向）：

```
You are a Retirement Specialist Agent focusing on long-term financial planning ...

Your role is to:
1. Project retirement income based on current portfolio
2. Run Monte Carlo simulations for success probability
3. Calculate safe withdrawal rates
4. Analyze portfolio sustainability
5. Provide retirement readiness recommendations

Key Analysis Areas:
- Retirement Income Projections (inflation-adjusted)
- Monte Carlo Analysis (best/worst case, depletion risk)
- Withdrawal Strategy (SWR, tax-efficient sequencing)
- Gap Analysis (trajectory vs. target)
- Risk Factors (longevity, inflation, healthcare, sequence risk)

Provide clear, actionable insights with specific numbers and timelines.
Use conservative assumptions ...
```

  而**真正的 task 字串是在 `agent.py` 的 `create_agent()` 裡用 f-string 即時組出來的**（把已算好的
  portfolio value、asset allocation、Monte Carlo 結果、各里程碑 projection 直接寫進去）。

  > ⚠️ 注意：`templates.py` 裡還有一個 `RETIREMENT_ANALYSIS_TEMPLATE`，但**目前程式碼並未使用它**
  > （task 是在 `agent.py` 內聯組裝）。而且那個舊模板寫「Monte Carlo (1000 scenarios)」，
  > 但實際程式碼跑的是 `num_simulations=500`——這是模板殘留、與實作不一致的地方，閱讀時別被誤導。

---

## 4. 設計原則總結（給未來的自己）

1. **LiteLLM/Bedrock 限制**：一個 Agent 不能同時用 Structured Output + Tools，二選一（或都不用）。
2. **能用程式碼編排就用程式碼**：明確的迴圈/條件（如 Tagger 補標籤）寫成 Python，放在 `Runner.run` 外面。
3. **需要 LLM 判斷才交給 Agent**：要不要呼叫哪些子 Agent，交給 Planner 的 tools 自主決定。
4. **Context 用 `RunContextWrapper`，不要用 global**：這是 OpenAI Agents SDK 推薦、乾淨的傳值方式。
5. **盡量讓 Agent 只做它最擅長的事**：數值計算 / 加總 / 模擬用 Python 先算好，Agent 專心做「產生文字 / JSON / 分類」。
6. **保持簡單**：LLM 產的程式碼常常過度設計，務必批判性地檢查、砍到最簡。

---

## 5. 端到端範例：跟著「小美」走一遍

用一個具體使用者把整個專案從點擊到看到結果串起來。

> **架構前提**：整個 Alex 現在是**清一色 Lambda 架構**——Researcher、5 個 agent、ingest、API 全部都是 Lambda。
> （原本 Researcher 部署在 App Runner，但 AWS App Runner 自 2026/4/30 起**不接受新客戶並進入維護模式**，
> 新學生建不出 App Runner 服務，因此透過 PR #39 `researcher_as_lambda` 遷到 Lambda。App Runner 已完全退出本專案。）

### 場景設定

**小美**，35 歲，想知道自己的退休投資組合健不健康。她的持倉是：

| 帳戶 | 持有 | 數量 |
|---|---|---|
| 401(k) | VTI（全美股市 ETF） | 100 股 |
| 401(k) | 現金 | $5,000 |
| Roth IRA | BND（債券 ETF） | 50 股 |

退休目標：30 年後退休，希望年收入 $80,000。

---

### 第 0 步：背景早就在跑（Researcher / Guide 4）

在小美登入之前，**Researcher Agent** 就一直在背景上網讀財經新聞、市場分析，把研究結果**轉成向量存進 S3 Vectors**（`financial-research` index）。

現在的部署方式（已從 App Runner 遷到 Lambda）：

```
Researcher Lambda（用 Bedrock + Playwright MCP，直接跑在 Lambda 裡）
  ├─ Lambda Function URL：可手動觸發 / 對外呼叫
  └─ EventBridge Scheduler：定時自動觸發（排程跑研究）
        │
        ▼
   上網爬資料 → 整理 → 存進 [S3 Vectors]
```

這條線跟小美這次操作是**完全脫鉤**的兩條獨立流程。等等 Reporter 會去查這些向量。

---

### 第 1 步：登入與輸入（Frontend / Guide 7）

```
小美 → NextJS 前端 (CloudFront 上的網站)
     → Clerk 驗證身分，拿到 clerk_user_id（例如 "user_abc123"）
     → 在畫面上建好帳戶、輸入持倉 (VTI×100, BND×50, $5000 cash)
     → 按下「分析我的投資組合」
```

此時前端打 API（API Gateway → FastAPI Lambda）。

---

### 第 2 步：建立 Job、丟進佇列（非同步的關鍵）

FastAPI 後端做兩件事就**立刻回應**，不卡著等分析：

```
1. 在資料庫建一筆 job：
   { job_id: "job-001", clerk_user_id: "user_abc123", status: "pending" }
2. 把 "job-001" 這個字串丟進 SQS Queue
3. 馬上回前端：「收到，處理中」→ 前端開始用 job-001 輪詢結果
```

> 這就是**架構層非同步**：使用者不必盯著畫面等 30 秒。

---

### 第 3 步：SQS 觸發 Planner（協調者上場 / Guide 6）

SQS 一有訊息就觸發 **Planner Lambda**。`lambda_handler` 從 `event['Records'][0]['body']` 取出 `"job-001"`，進入 `run_orchestrator("job-001")`：

```python
db.jobs.update_status("job-001", "running")   # 標記開始
```

接下來 Planner 做 **3 件純 Python 預處理**（不是 Agent，是程式碼編排）：

#### 3a. `handle_missing_instruments()` — 必要時叫 Tagger

```
掃 job-001 的持倉 → symbol = [VTI, BND]
查資料庫：
  - VTI 已經有 allocation 資料 ✅ → 跳過
  - BND 從沒被分類過 ❌ → 加進待分類清單
把 [{symbol: "BND", name: "Vanguard Total Bond Market ETF"}] 丟給 Tagger Lambda
```

**Tagger Agent**（structured output，`tools=[]`）收到 BND，用 **Nova 自己的知識**產生：

```
BND → asset_class: {fixed_income: 100}      （加總 100 ✅，Pydantic 驗證通過）
      regions:     {north_america: 100}
      sectors:     {treasury: 60, corporate: 40}
      current_price: ~$72（模型估的）
```

寫回資料庫的 `instruments` 表。現在 VTI、BND 都有完整分類了。

#### 3b. `update_instrument_prices()` — 校正價格

用真實市場資料更新 VTI、BND 的現價（蓋掉 Tagger 估的價）。

#### 3c. `load_portfolio_summary()` — 取摘要

只算統計數字（不取完整資料，省 token）：

```
{ total_value: ~$28,600, num_positions: 2, years_until_retirement: 30, target_income: 80000 }
```

---

### 第 4 步：Planner Agent 自主決定呼叫誰

現在才進入 LLM。Planner 建立 Agent（帶 3 個 tool + `PlannerContext(job_id="job-001")`），`Runner.run` 跑起來。它的 prompt 規則：

```
positions = 2 → invoke_reporter ✅（>0）
positions = 2 → invoke_charter  ✅（>=2）
有退休目標    → invoke_retirement ✅
```

於是 LLM 決定**三個都呼叫**。每個 tool 透過 `RunContextWrapper` 拿到 `job_id="job-001"`，去 invoke 對應的 Lambda。

---

### 第 5 步：三個專家 Agent 各自工作

**Reporter（報告，用 tool + context）**
```
1. 收到 job-001，從 DB 載入小美的完整持倉
2. 呼叫 get_market_insights(["VTI","BND"]):
     query → SageMaker 算 embedding → 去 S3 Vectors 撈 top 3 相關市場研究
     （這裡就接上了第 0 步 Researcher 存的內容！）
3. LLM 結合「持倉 + 市場洞察」寫出 markdown 報告
4. judge 評分 → 分數夠 → db.jobs.update_report("job-001", 報告)
```

**Charter（圖表，純文字輸出 JSON）**
```
1. Python 先把持倉算成各維度金額（analyze_portfolio）
2. LLM 只負責產出 4-6 張圖的 JSON：
     - 資產類別圓餅圖（股 vs 債 vs 現金）
     - 地區分布、產業分布、帳戶分布、前幾大持倉
3. lambda 用 find('{')/rfind('}') 抓 JSON → db.jobs.update_charts(...)
```

**Retirement（退休，純文字、tools=[]）**
```
1. Python 先跑 Monte Carlo 模擬 500 次（累積期+提領期）
     → 成功率、各百分位、各里程碑 projection
2. 把模擬結果全塞進 prompt（不用 tool，因為資料一定在 context）
3. LLM 寫出退休準備度分析 → db.jobs.update_retirement(...)
```

> 這三個會被 Planner 依序（或並行）呼叫，各自把結果寫進**同一筆 job-001** 的不同欄位。

---

### 第 6 步：Planner 收尾

三個 tool 都回傳成功後，Planner Agent 回 `"Done"`，`run_orchestrator` 最後：

```python
db.jobs.update_status("job-001", "completed")
```

---

### 第 7 步：前端拿到結果

```
前端一直在輪詢 GET /jobs/job-001
  status: pending → running → running → completed ✅
拿到 completed 後，讀出：
  - report（markdown 報告）   → 渲染成文字分析
  - charts（JSON）            → Recharts 畫成互動圖表
  - retirement（markdown）    → 顯示退休準備度與建議
小美看到完整的投資組合儀表板 🎉
```

---

### 整條流程一圖總覽

```
[Researcher Lambda] ──持續寫──► [S3 Vectors] ◄──查詢── (Reporter 會用)
  (EventBridge 定時觸發,
   Playwright MCP 跑在 Lambda 內,
   背景獨立運作)

小美 ─► 前端/Clerk ─► API/FastAPI ─► 建 job + 丟 SQS ─► (立刻回「處理中」)
                                              │
                                              ▼
                                     [SQS] ─► Planner Lambda
                                              │
            ┌─────────── 程式碼編排 (Python) ──┤
            │  handle_missing_instruments ────┼─► Tagger Lambda（分類 BND）
            │  update_instrument_prices       │
            │  load_portfolio_summary         │
            └─────────── 自主編排 (LLM tools) ─┤
                                              ├─► Reporter Lambda ─► (查 S3 Vectors) ─► DB
                                              ├─► Charter Lambda  ──────────────────► DB
                                              └─► Retirement Lambda (Monte Carlo) ──► DB
                                              │
                                  status = "completed"
                                              │
小美 ◄── 前端輪詢拿到 report + charts + retirement ◄── DB
```

### 三個應該記住的設計重點

1. **兩段式編排**：「該分類哪些商品」是明確迴圈 → 用 Python 叫 Tagger；「該呼叫哪些專家」需要判斷 → 交給 Planner 的 LLM tools 決定。
2. **非同步**：SQS 讓使用者「丟了就走」，後台慢慢跑，前端用 `job_id` 輪詢。
3. **跨週串接**：Reporter 的 `get_market_insights` 把這週的多代理系統，接上了上週 Researcher 寫進 S3 Vectors 的市場研究。

---

*依據程式碼整理，對應 Guide 6 (AI Agent Orchestra)。*
