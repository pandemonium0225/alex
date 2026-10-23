# Guide 9: 期末作業 — Alex 三大強化方向實作規格

> 這份文件是針對 Ed 在課程結尾提出的三個延伸方向（資料工程 / MLOps / Agentic AI），
> 對照 **目前 Alex 程式庫的實際狀態**整理出來的具體實作規格（spec）。
> 每個方向都包含：現狀分析 → 缺口 → 目標 → 逐步實作步驟 → 程式碼草案 → 驗收方式。
> 三個方向可以只選一個深入做，也可以像 Ed 建議的那樣做成「三重奏」，因為它們會互相增益
> （例如方向三的 retirement↔reporter 依賴關係，剛好可以用方向二的 judge/guardrail 機制來把關）。

---

## 共同前提：目前架構回顧

- **Planner** (`backend/planner/lambda_handler.py`) 是唯一的 orchestrator：
  先做 `handle_missing_instruments` → `update_instrument_prices`（用 Polygon，見 `backend/planner/prices.py`）
  → `load_portfolio_summary` → 用 OpenAI Agents SDK 跑一個只有三個工具
  (`invoke_reporter` / `invoke_charter` / `invoke_retirement`) 的 orchestrator agent。
- 三個下游 agent（Reporter / Charter / Retirement）**完全互相獨立**：
  它們的 `lambda_handler.py` 都是各自從 DB 重新撈一次 `portfolio_data` / `user_data`，
  彼此看不到對方的輸出，也看不到彼此的存在。
- **Researcher**（`backend/researcher/server.py`）實際上**不是跑在 App Runner**——
  `terraform/4_researcher/main.tf` 部署的是一個 container-image 的 **Lambda**
  (`aws_lambda_function.researcher`)，靠 **Lambda Function URL**
  (`aws_lambda_function_url.researcher`) 對外提供 HTTP 介面（`output.researcher_url`）。
  程式碼跟變數裡到處留著 `APP_RUNNER_URL` 這個命名（`backend/scheduler/lambda_function.py`、
  `terraform/4_researcher/main.tf` 第 203 行）只是早期設計的命名遺留，目前架構已經改成
  Lambda + Function URL，這份文件下面一律以實際架構（Lambda Function URL）來寫，
  不再用 App Runner 的措辭。
  另外，EventBridge 排程其實**已經存在**：`aws_scheduler_schedule.research_schedule`
  每 2 小時觸發 `alex-researcher-scheduler` 這個 Lambda
  (`backend/scheduler/lambda_function.py`)，對 `/research` 發一個空 JSON body
  （等同於讓 agent 自己選主題）。目前的 `/research/auto` 端點使用的是
  `DEFAULT_RESEARCH_PROMPT`：「挑一個今天市場上有趣的主題」——跟任何使用者的
  portfolio 完全無關。
- 知識庫寫入 (`ingest_financial_document`) 只存 `{topic, timestamp}` 當 metadata，
  檢索 (`get_market_insights` in `backend/reporter/agent.py`) 用的是純語意相似度搜尋，
  沒有 symbol-level 過濾，命中率基本看運氣。
- **監控**：`terraform/8_enterprise/main.tf` 目前只有兩個 **CloudWatch Dashboard**
  （`ai-model-usage`、`agent-performance`），完全沒有 `aws_cloudwatch_metric_alarm`、
  沒有 SNS 通知。
- **護欄**：只有 `backend/reporter/judge.py` 這一個 LLM-as-judge，而且只接在 Reporter
  身上（`GUARD_AGAINST_SCORE = 0.3`，低於門檻就把回覆換成制式拒絕訊息）。
  Charter / Retirement / Planner 完全沒有任何品質把關。
- **Observability**：`observability.py` 在四個 agent 目錄下幾乎是同一份複製貼上的程式碼，
  有接 LangFuse（透過 logfire instrument），但目前只用來「送 trace」，沒有任何長期趨勢
  追蹤或 drift 偵測。

以上就是三個方向的「起點」。下面分別展開。

---

## 方向一：資料工程 — 讓 Researcher 真正了解使用者的投資組合

### 目標

把 Researcher 從「每次隨機選一個市場熱門話題」，改成「根據使用者實際持有的標的、
產業曝險、以及偏離目標配置的程度，去研究真正相關的主題，並把結果用可被精準檢索的
方式存進知識庫」。打通上週（Researcher / S3 Vectors）跟本週（Planner / Reporter）
之間的斷點。

### 步驟 1：在 Planner 算出「研究主題清單」

新增 `backend/planner/research_topics.py`（沿用 `load_portfolio_summary` 已經算過的
資料結構，避免重複查詢）：

```python
"""Derive portfolio-relevant research topics for the Researcher agent."""
from typing import Any, Dict, List
import logging

logger = logging.getLogger()


def get_research_topics(job_id: str, db, max_topics: int = 5) -> List[Dict[str, Any]]:
    """
    Returns a ranked list of research topics derived from the user's actual holdings:
    - top N holdings by market value (always relevant — biggest dollar impact)
    - asset classes / regions most overweight vs. the user's stated targets
    Each topic carries the symbols it relates to, so the result can be tagged
    in the knowledge base with filterable metadata.
    """
    job = db.jobs.find_by_id(job_id)
    user_id = job["clerk_user_id"]
    user = db.users.find_by_clerk_id(user_id)
    accounts = db.accounts.find_by_user(user_id)

    position_values: Dict[str, float] = {}
    asset_class_totals: Dict[str, float] = {}
    region_totals: Dict[str, float] = {}
    total_value = 0.0

    for account in accounts:
        for position in db.positions.find_by_account(account["id"]):
            instrument = db.instruments.find_by_symbol(position["symbol"])
            if not instrument or not instrument.get("current_price"):
                continue
            value = float(position["quantity"]) * float(instrument["current_price"])
            position_values[position["symbol"]] = position_values.get(position["symbol"], 0) + value
            total_value += value

            for asset_class, pct in (instrument.get("allocation_asset_class") or {}).items():
                asset_class_totals[asset_class] = asset_class_totals.get(asset_class, 0) + value * pct / 100
            for region, pct in (instrument.get("allocation_regions") or {}).items():
                region_totals[region] = region_totals.get(region, 0) + value * pct / 100

    if total_value == 0:
        return []

    topics: List[Dict[str, Any]] = []

    # 1) Top holdings by value — always research the biggest positions.
    top_symbols = sorted(position_values.items(), key=lambda kv: kv[1], reverse=True)[:3]
    for symbol, value in top_symbols:
        topics.append({
            "topic": f"Latest news and outlook for {symbol}",
            "symbols": [symbol],
            "reason": "top_holding",
            "weight_pct": round(value / total_value * 100, 1),
        })

    # 2) Asset classes that drift from the user's stated targets.
    targets = (user.get("asset_class_targets") or {})
    for asset_class, target_pct in targets.items():
        actual_pct = asset_class_totals.get(asset_class, 0) / total_value * 100
        drift = actual_pct - target_pct
        if abs(drift) >= 10:  # meaningful drift threshold
            topics.append({
                "topic": f"{asset_class} market outlook given {'over' if drift > 0 else 'under'}weight allocation",
                "symbols": [s for s, _ in top_symbols],
                "reason": "asset_class_drift",
                "drift_pct": round(drift, 1),
            })

    return topics[:max_topics]
```

### 步驟 2：讓 Researcher 接受 symbol-level metadata

修改 `backend/researcher/tools.py` 的 `ingest_financial_document`，讓研究結果跟它
研究的標的綁在一起（這是讓檢索變精準的關鍵）：

```python
@function_tool
def ingest_financial_document(topic: str, analysis: str, symbols: list[str] = []) -> Dict[str, Any]:
    """
    Args:
        topic: ...
        analysis: ...
        symbols: Ticker symbols this analysis is about (e.g. ["AAPL", "MSFT"]).
                  Leave empty for general market commentary.
    """
    ...
    document = {
        "text": analysis,
        "metadata": {
            "topic": topic,
            "symbols": symbols,          # NEW — filterable metadata
            "timestamp": datetime.now(UTC).isoformat(),
        },
    }
```

同時把 `context.py` 的 instructions 改成要求 agent 在呼叫工具時填 `symbols`
（目前的 instructions 完全沒提到 symbol，模型自然不會主動填）。

> ⚠️ S3 Vectors 是相對新的 preview 服務，`query_vectors` 是否支援 metadata filter、
> filter 語法為何，請在實作前對照你目前 boto3 版本的 `s3vectors` API 文件確認一次
> （建議先用 `aws s3vectors help` 或 boto3 的 service model 確認 `filter` 參數存在）。
> 如果該版本不支援 filter，退路是：在查詢端先用 `topK` 拿較多結果（例如 20），
> 再用 Python 對 `metadata.symbols` 做後過濾。

### 步驟 3：新增 Planner → Researcher 的呼叫路徑

Researcher 雖然底層也是 Lambda，但對外是透過 **Lambda Function URL**
提供 HTTP 端點（不是像 Reporter/Charter/Retirement 那樣用
`lambda_client.invoke()` 直接呼叫），所以呼叫方式要用 HTTP 而不是
`lambda_client.invoke`。在 `backend/planner/agent.py` 新增：

```python
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

RESEARCHER_URL = os.getenv("RESEARCHER_URL")  # Lambda Function URL, from terraform output "researcher_url"


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=15))
async def _call_researcher(topic: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(f"{RESEARCHER_URL}/research", json={"topic": topic})
        response.raise_for_status()
        return response.json()


@function_tool
async def invoke_researcher(wrapper: RunContextWrapper[PlannerContext]) -> str:
    """Research topics relevant to this user's actual portfolio and store findings."""
    topics = get_research_topics(wrapper.context.job_id, db)
    if not topics:
        return "No research topics derived from portfolio (empty or all prices missing)."

    results = []
    for t in topics:
        try:
            await _call_researcher(t["topic"])
            results.append(f"researched: {t['topic']}")
        except Exception as e:
            results.append(f"failed: {t['topic']} ({e})")
    return "; ".join(results)
```

把 `invoke_researcher` 加進 `tools = [...]`，並更新
`backend/planner/templates.py` 的 `ORCHESTRATOR_INSTRUCTIONS`，明確告訴 orchestrator
「在呼叫 Reporter 之前，先呼叫 invoke_researcher，確保知識庫有跟這個使用者持股相關的
最新資訊」。

### 步驟 4：Terraform 串接（Researcher Function URL → Planner 環境變數）

`terraform/4_researcher/outputs.tf` 已經有 `output "researcher_url"`
（也就是 `aws_lambda_function_url.researcher[0].function_url`）。在
`terraform/6_agents/main.tf`
的 planner Lambda 環境變數區塊加一個變數，並在 `terraform.tfvars` 手動貼上
`terraform output` 的值（這個 repo 是 per-guide 獨立 state，沒有 remote state
data source，所以維持現有「手動複製 output」的慣例即可，不需要引入 S3 backend）：

```hcl
# terraform/6_agents/variables.tf
variable "researcher_url" {
  description = "Researcher Lambda Function URL (from terraform/4_researcher output.researcher_url)"
  type        = string
}

# terraform/6_agents/main.tf, planner aws_lambda_function 的 environment block 新增：
RESEARCHER_URL = var.researcher_url
```

### 步驟 5：改寫排程研究的邏輯（隱私安全的彙整版）

`terraform/4_researcher/main.tf` 裡的 `aws_scheduler_schedule.research_schedule`
已經每 2 小時觸發 `alex-researcher-scheduler` 這個 Lambda
（程式碼在 `backend/scheduler/lambda_function.py`），目前它只是對 `/research`
POST 一個空 JSON body，等同於讓 agent 隨機選主題——不需要新增資源，直接改寫
這個既有的 `handler()`：先連資料庫，彙整「所有活躍使用者持股的熱度排行」
（`SELECT symbol, COUNT(*) FROM positions GROUP BY symbol ORDER BY 2 DESC LIMIT 5`），
再對熱門 symbol 逐一 POST `{"topic": f"...{symbol}..."}` 到 `/research`，
而不是對單一使用者的個人持股做排程研究——這樣排程研究服務的就是「全平台共用的
知識庫」，不會把單一使用者的持股偏好暴露在排程任務的 log 或 payload 裡。

> 這個 scheduler Lambda 目前用 `urllib.request`（標準函式庫，沒有額外依賴），
> 如果要連資料庫，記得把它從「裸 Lambda + zip」升級成跟其他 agent 一樣用
> `backend/database` 的 uv 套件打包，或者更輕量的做法：另外開一支極簡的
> read-only DB 查詢 Lambda 給它呼叫，避免把完整 ORM 依賴塞進這個本來很小的函式。

### 步驟 6：避免重複研究（成本與新鮮度控制）

在 `invoke_researcher` 呼叫前，先用 `search_s3vectors.py` 的邏輯查詢「該 symbol
是否已有 7 天內的研究」，有的話就跳過，省下 Playwright + Bedrock 的呼叫成本。

```python
def _has_recent_research(symbol: str, days: int = 7) -> bool:
    results = search_vectors(query=symbol, k=3)  # reuse search_s3vectors logic
    cutoff = datetime.now(UTC) - timedelta(days=days)
    return any(
        symbol in r["metadata"].get("symbols", [])
        and datetime.fromisoformat(r["metadata"]["timestamp"]) > cutoff
        for r in results
    )
```

### 驗收方式

1. `MOCK_LAMBDAS=true uv run test_simple.py`（planner）：確認 `invoke_researcher`
   工具被呼叫、`get_research_topics` 回傳的 topic 清單符合測試用 portfolio fixture。
2. 真實部署後，跑一次完整分析，去 S3 Vectors 用 `search_s3vectors.py` 查詢
   你 portfolio 裡的某個 symbol，確認新存進去的向量 metadata 帶有正確的 `symbols`。
3. 觸發第二次分析，確認 `_has_recent_research` 生效（CloudWatch log 應該看到
   `skipped: ... already researched`，而不是又跑一次 Playwright）。
4. 打開 Reporter 產生的報告，確認「Market Context」段落引用的內容真的跟使用者持股
   有關，而不是泛泛的市場新聞。

---

## 方向二：MLOps — 監控告警、護欄、模型/品質漂移追蹤

### 目標

把現有的「兩個 dashboard + 一個只接在 Reporter 上的 judge」，補成「會主動通知人」、
「四個 agent 都有把關」、「品質趨勢可被長期追蹤並在下滑時提早示警」的完整 MLOps 迴圈。

### 步驟 1：CloudWatch Alarms + SNS（"everything goes down" 告警）

新增 `terraform/8_enterprise/alarms.tf`：

```hcl
resource "aws_sns_topic" "alex_alerts" {
  name = "${local.name_prefix}-alerts"
  tags = local.common_tags
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alex_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  agent_function_names = [
    "alex-planner", "alex-reporter", "alex-charter",
    "alex-retirement", "alex-tagger",
    "alex-researcher", "alex-researcher-scheduler",  # both are plain Lambdas too
  ]
}

resource "aws_cloudwatch_metric_alarm" "agent_errors" {
  for_each            = toset(local.agent_function_names)
  alarm_name          = "${local.name_prefix}-${each.value}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alex_alerts.arn]
  ok_actions          = [aws_sns_topic.alex_alerts.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "bedrock_server_errors" {
  alarm_name          = "${local.name_prefix}-bedrock-server-errors"
  namespace           = "AWS/Bedrock"
  metric_name         = "InvocationServerErrors"
  dimensions          = { ModelId = var.bedrock_model_id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alex_alerts.arn]
  tags                = local.common_tags
}
```

`alex-researcher` 跑在 Lambda Function URL 後面（不是 App Runner，沒有
`AWS/AppRunner` 這個 namespace 可用），但它的 5xx／逾時其實就反映在標準的
`AWS/Lambda` `Errors` 跟 `Duration`（逾時會算進 Errors）指標裡，所以上面的
`agent_errors` for_each（已經把 `alex-researcher` 跟 `alex-researcher-scheduler`
加進 `agent_function_names`）就足夠覆蓋，不需要另外的服務層 alarm。

加上 `var.alert_email`（`variables.tf`）並在 `terraform.tfvars` 填入你自己的 email；
`terraform apply` 後 SNS 會寄一封確認訂閱信，務必點擊確認，不然不會收到告警。

### 步驟 2：護欄（Guardrails）— 硬編碼規則 + LLM-as-judge，套用到全部 4 個 agent

現況 `judge.py` 的模式（Pydantic `Evaluation` + 門檻擋掉低分輸出）已經是對的雛形，
只是只接在 Reporter。建議抽成共用模組，放進 `backend/database/src`（這個套件本來就
被四個 agent uv project 共用），新增 `backend/database/src/guardrails.py`：

```python
"""Shared guardrails for all Alex agents: hardcoded checks + LLM-as-judge."""
import re
import logging
from dataclasses import dataclass

logger = logging.getLogger()

# --- Hardcoded guardrails (cheap, deterministic, run before the LLM judge) ---

PROHIBITED_PATTERNS = [
    re.compile(r"\bguarantee[ds]?\b.*\breturn", re.I),   # "guaranteed returns"
    re.compile(r"\brisk[- ]free\b", re.I),
    re.compile(r"\b(buy|sell)\s+(now|immediately)\b", re.I),  # avoid prescriptive trade timing
]

REQUIRED_DISCLAIMER_MARKER = "not a registered financial advisor"


@dataclass
class GuardrailResult:
    passed: bool
    reason: str = ""


def check_hardcoded_guardrails(text: str) -> GuardrailResult:
    for pattern in PROHIBITED_PATTERNS:
        if pattern.search(text):
            return GuardrailResult(False, f"Matched prohibited pattern: {pattern.pattern}")
    if len(text) < 50:
        return GuardrailResult(False, "Output suspiciously short — likely a model failure")
    return GuardrailResult(True)


def ensure_disclaimer(text: str, disclaimer: str) -> str:
    """Append the compliance disclaimer if the agent didn't already include one."""
    if REQUIRED_DISCLAIMER_MARKER not in text.lower():
        return f"{text}\n\n---\n*{disclaimer}*"
    return text
```

每個 `lambda_handler.py`（planner / reporter / charter / retirement）統一套用：

```python
from src.guardrails import check_hardcoded_guardrails, ensure_disclaimer
from judge import evaluate  # move judge.py up to backend/database/src too, shared by all 4

DISCLAIMER = "Alex is not a registered financial advisor. This analysis is for informational purposes only."
GUARD_AGAINST_SCORE = 0.3

hard_check = check_hardcoded_guardrails(response)
if not hard_check.passed:
    logger.error(f"Guardrail blocked output: {hard_check.reason}")
    response = "I'm sorry, I can't provide that analysis. Please contact support."
else:
    evaluation = await evaluate(AGENT_INSTRUCTIONS, task, response)
    score = evaluation.score / 100
    if score < GUARD_AGAINST_SCORE:
        response = "I'm sorry, I'm not able to generate this analysis right now. Please try again later."
    response = ensure_disclaimer(response, DISCLAIMER)
```

> `judge.py` 目前寫死引用 Reporter 的措辭（"financial report"），把它泛化成接受
> `agent_label: str` 參數（"financial report" / "retirement projection" / "chart
> specification"），這樣四個 agent 可以共用同一份評審邏輯但給出針對性的 prompt。

### 步驟 3：模型/品質漂移追蹤

這是 Ed 特別強調的部分：「記錄一些指標，丟進 LangFuse，然後追蹤它們隨時間的變化」。
具體做法分三層：

**(a) 資料庫留存每次評分** — 新增 migration
`backend/database/migrations/002_quality_metrics.sql`：

```sql
CREATE TABLE IF NOT EXISTS agent_quality_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    agent_name VARCHAR(50) NOT NULL,       -- 'reporter', 'retirement', 'charter', 'planner'
    judge_score DECIMAL(5,2) NOT NULL,     -- 0-100
    judge_feedback TEXT,
    latency_ms INTEGER,
    bedrock_model_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_metrics_agent_time
    ON agent_quality_metrics(agent_name, created_at);
```

每個 agent 在判定分數後寫入一筆紀錄（用 `db.client` 直接 execute，或在
`backend/database/src/models.py` 加一個 `QualityMetrics` repository，仿照
`db.jobs` / `db.accounts` 已有的模式）。

**(b) 推送自訂 CloudWatch 指標**（這樣品質趨勢可以跟 Lambda errors / Bedrock latency
放在同一個 dashboard，也可以掛 alarm，不需要額外去 LangFuse UI 才能看到示警）：

```python
import boto3

cloudwatch = boto3.client("cloudwatch")

def publish_quality_metric(agent_name: str, score: float) -> None:
    cloudwatch.put_metric_data(
        Namespace="Alex/AgentQuality",
        MetricData=[{
            "MetricName": "JudgeScore",
            "Dimensions": [{"Name": "AgentName", "Value": agent_name}],
            "Value": score,           # 0-100
            "Unit": "None",
        }],
    )
```

**(c) Drift alarm** — 在 `terraform/8_enterprise/alarms.tf` 加一個用「7 天平均分數」
偵測逐漸下滑的告警（用 anomaly detection band，比固定 threshold 更適合「漸進式下滑」）：

```hcl
resource "aws_cloudwatch_metric_alarm" "quality_drift" {
  for_each            = toset(["reporter", "retirement", "charter"])
  alarm_name          = "${local.name_prefix}-${each.value}-quality-drift"
  comparison_operator = "LessThanLowerThreshold"
  evaluation_periods  = 3
  threshold_metric_id  = "ad1"
  alarm_actions        = [aws_sns_topic.alex_alerts.arn]

  metric_query {
    id = "m1"
    metric {
      namespace   = "Alex/AgentQuality"
      metric_name = "JudgeScore"
      dimensions  = { AgentName = each.value }
      period      = 86400  # daily
      stat        = "Average"
    }
  }

  metric_query {
    id          = "ad1"
    expression  = "ANOMALY_DETECTION_BAND(m1, 2)"
    label       = "JudgeScore (expected range)"
  }
}
```

這個 alarm 會學出「正常分數區間」，當平均分數連續 3 天低於該區間下緣時觸發 —— 正好
對應 Ed 說的「逐漸下滑，提早示警」，而不是單次低分就誤報。

**(d) LangFuse 端**：`observability.py` 裡已經有 `span.score(name="Judge", ...)` 的
寫法（目前只在 reporter 的 lambda_handler 用），把同一個呼叫套到其餘三個 agent，
LangFuse 後台的 Score 趨勢圖就能跨 agent 比較。

### 驗收方式

1. 故意讓某個 Lambda 丟例外（例如暫時把 `BEDROCK_MODEL_ID` 改成不存在的 model id
   再部署），確認 5 分鐘內收到 SNS email。
2. 餵一段含 "guaranteed returns" 字樣的假輸出進 `check_hardcoded_guardrails`
   單元測試，確認被擋下。
3. 跑 10 次分析後查 `agent_quality_metrics` 表，確認每個 agent 都有對應分數紀錄；
   去 CloudWatch 看 `Alex/AgentQuality` namespace 確認指標有進來。
4. （進階）手動把幾筆歷史分數改低，觀察 anomaly detection alarm 是否在下一次評估
   週期進入 `ALARM` 狀態。

---

## 方向三：Agentic AI — 提升財務規劃的實質品質

這是 Ed 最期待、也是改動完後「使用者真正看得出差異」的方向：讓三個 agent 不再
各自為政，給它們更好的工具、更真實的資料、更深入的研究能力。

### 問題 1：Agent 之間零互動

目前 `backend/planner/agent.py` 的 `invoke_reporter_internal` /
`invoke_charter_internal` / `invoke_retirement_internal` 都只傳 `{"job_id": job_id}`，
三個 agent 各自從 DB 重新讀一次同樣的 portfolio。Retirement agent 完全看不到
Reporter 寫的風險評估敘述；Charter 也看不到 Reporter 認為「哪裡需要視覺化強調」。

**修法**：讓 Reporter 先跑，把結果存回 `jobs.report_payload`（已經有這個欄位，
`db.jobs.update_report` 已經存在），然後讓 Planner 的 orchestrator instructions
明確要求「先 invoke_reporter，再 invoke_retirement 和 invoke_charter」，並讓
Retirement / Charter 的 `lambda_handler.py` 多讀一次 `job.report_payload`：

```python
# backend/retirement/lambda_handler.py — 在組 task 之前
job = db.jobs.find_by_id(job_id)
report_context = ""
if job.get("report_payload"):
    report_content = job["report_payload"].get("content", "")
    report_context = f"\n\n## Context from Portfolio Report (already written)\n{report_content[:2000]}\n"
```

再把 `report_context` 接到 `backend/retirement/agent.py` 的 `task` 字串尾端，
讓 Retirement agent 的建議跟 Reporter 已經指出的弱點對齊，而不是各說各話。
`backend/planner/templates.py` 的 `ORCHESTRATOR_INSTRUCTIONS` 也要加一句明確的
循序要求，因為 OpenAI Agents SDK 的工具呼叫順序預設由模型自行決定，不會自動序列化。

### 問題 2：Retirement 的 Monte Carlo 太簡化、且是一次性算完，Agent 無法互動式調整

`backend/retirement/agent.py` 的 `run_monte_carlo_simulation` 完全在 `create_agent`
裡跑一次性計算後把結果塞進文字 prompt，agent 本身**沒有任何工具**
（`tools = []`），所以它只能「評論」既定的數字，無法「假設情境再算一次」。

**修法**：把 `run_monte_carlo_simulation` 包成 `function_tool`，讓 agent 自己決定
要不要做敏感度分析（例如「如果把股票配置降到 50% 會怎樣？」）：

```python
from agents import function_tool

@function_tool
def rerun_simulation_with_allocation(
    equity_pct: float, bonds_pct: float, real_estate_pct: float, cash_pct: float
) -> Dict[str, Any]:
    """Re-run the Monte Carlo simulation with a hypothetical asset allocation,
    to compare against the user's current allocation. Percentages should sum to ~100."""
    allocation = {
        "equity": equity_pct / 100, "bonds": bonds_pct / 100,
        "real_estate": real_estate_pct / 100, "cash": cash_pct / 100,
    }
    return run_monte_carlo_simulation(
        _portfolio_value, _years_until_retirement, _target_income, allocation
    )
```

（`_portfolio_value` 等用 closure 或搬進一個小 context dataclass，跟 Reporter 已經用
的 `RunContextWrapper[ReporterContext]` 模式一致。）這樣 Retirement agent 的最終報告
就能包含「如果你把配置改成 X，成功率會從 Y% 提升到 Z%」這種真正有行動力的建議，而不是
固定算一次就只能口頭描述。

同時，現有模擬用常態分佈假設報酬（`random.gauss`），統計上對「黑天鵝尾部風險」估計
過於樂觀。如果要做更嚴謹的版本，可以改成 **historical bootstrapping**：抓一段
S&P 500 / 美國公債歷史月報酬序列，每次模擬隨機抽樣（取代固定 mean/std 的常態分佈），
更真實反映報酬的厚尾與序列相關性。這塊可以是一個獨立的子任務。

### 問題 3：Reporter 引用的「市場洞察」其實跟使用者持股無關（已在方向一處理檢索面）；
缺少**即時**個股資料工具

目前 Reporter 只能講 `instrument.current_price`（前一天/前一分鐘的靜態收盤價，
由 Planner 在跑 agent 之前批次更新，存在 DB 裡），它自己沒有工具能在分析過程中
臨時查「這支股票最近 52 週高低點、最新財報重點」。`backend/planner/prices.py`
已經封裝了 Polygon client，可以直接重用：

```python
# backend/reporter/agent.py — 新增工具，重用 planner 已驗證過的 Polygon 封裝邏輯
from polygon import RESTClient

polygon_client = RESTClient(os.getenv("POLYGON_API_KEY"))

@function_tool
async def get_company_snapshot(
    wrapper: RunContextWrapper[ReporterContext], symbol: str
) -> str:
    """Get a real-time snapshot (price, day range, volume) for a ticker from Polygon."""
    try:
        snap = polygon_client.get_snapshot_ticker("stocks", symbol)
        return (
            f"{symbol}: last={snap.min.close}, "
            f"day_high={snap.day.high}, day_low={snap.day.low}, "
            f"volume={snap.day.volume}"
        )
    except Exception as e:
        return f"Snapshot unavailable for {symbol}: {e}"
```

把這個工具加進 `tools = [get_market_insights, get_company_snapshot]`，並在
`backend/reporter/templates.py` 的 instructions 提示模型「針對前 3 大持股，呼叫
get_company_snapshot 取得當下數據再寫進報告」。

> 注意 `POLYGON_API_KEY` 免費版有 rate limit（5 calls/min），規劃 max_turns 跟工具
> 呼叫次數時要留意，必要時對這個工具也套用 `tenacity` 的 `wait_exponential` retry
> （參考 `backend/researcher/tools.py` 的 `ingest_with_retries` 寫法）。

### 問題 4：Researcher 是單輪、淺層研究

`context.py` 的 instructions 要求「最多瀏覽 2 個網頁、3-5 個 bullet point」——
這是為了控制單次執行時間，但代價是研究深度幾乎等於沒有。

**修法（深度研究的最小可行版本）**：把單一 Runner.run 拆成兩階段，用 OpenAI Agents
SDK 的多次 `Runner.run` 而不必上 `handoffs`（量級上更輕，比較容易塞進目前 Researcher
Lambda 的 timeout 限制）：

```python
async def run_deep_research(topic: str) -> str:
    # Stage 1: a fast "scout" pass — no browsing, just decompose the topic.
    scout = Agent(name="Scout", instructions=SCOUT_INSTRUCTIONS, model=model)
    scout_result = await Runner.run(
        scout, input=f"Break this into 3 specific sub-questions to research: {topic}", max_turns=1
    )
    sub_questions = parse_sub_questions(scout_result.final_output)  # simple line-split / JSON

    # Stage 2: research each sub-question with the existing browsing agent, in parallel.
    async with create_playwright_mcp_server(timeout_seconds=60) as mcp:
        researcher = Agent(name="Researcher", instructions=get_agent_instructions(), model=model,
                            tools=[ingest_financial_document], mcp_servers=[mcp])
        results = await asyncio.gather(*[
            Runner.run(researcher, input=f"Research: {q}", max_turns=8)
            for q in sub_questions
        ])

    # Stage 3: a synthesis pass combines the sub-answers into one ingested document.
    synthesis_input = "\n\n".join(r.final_output for r in results)
    synthesizer = Agent(name="Synthesizer", instructions=SYNTHESIS_INSTRUCTIONS,
                         model=model, tools=[ingest_financial_document])
    final = await Runner.run(synthesizer, input=synthesis_input, max_turns=3)
    return final.final_output
```

這個結構讓你之後也能很自然地接上方向一的 `symbols` metadata（在 Stage 3 把
`topic` 涉及的 symbols 一起傳給 `ingest_financial_document`）。

> ⚠️ `aws_lambda_function.researcher`（`terraform/4_researcher/main.tf`）目前
> `timeout = 300`（5 分鐘）、`memory_size = 2048`。Lambda Function URL 走的是
> 函式本身的 timeout（不像 API Gateway 有 29 秒上限），但 300 秒對「scout →
> 平行深入研究 → synthesis」三階段仍然偏緊，加上 Stage 2 用 `asyncio.gather`
> 同時開多個 Playwright MCP context 會疊加記憶體/CPU 壓力。建議先用 2-3 個
> 子問題、調低 `max_turns` 測試實際耗時，必要時把 `timeout` 和 `memory_size`
> 一起調大（記得同步檢查 Lambda 帳戶層級的 concurrent execution 限制）。

### 驗收方式

1. 跑一次完整分析，打開 `jobs.retirement_payload`，確認內容有引用 Reporter
   報告裡提到的具體風險點（人工檢查文字是否呼應，而不只是格式正確）。
2. 在 Retirement 報告裡看到至少一個「情境比較」（呼叫 `rerun_simulation_with_allocation`
   產生的對照數字），而不是單一固定情境。
3. Reporter 報告的「Market Context」段落，標的對應的數字跟你自己去 Polygon /
   Yahoo Finance 核對的當下行情一致（容許正常的資料延遲）。
4. 跑一次 deep research，檢查知識庫裡新增的文件是否確實包含 3 個子主題的綜合內容，
   而不是原來「2 頁瀏覽、3-5 點」的單薄版本。

---

## 建議的優先順序

如果只能挑一個方向深入：**方向三（Agentic AI）對使用者體感的提升最大**，也是
Ed 特別點名「這是目前最不出色的部分」。但方向三的「問題 1（agent 依賴）」幾乎不花
額外 AWS 成本、改動範圍小（只是 instructions + 多讀一次 `report_payload`），
非常適合當作起手式，做完就能感受到報告品質的質變。

如果想做三重奏（data engineering + MLOps + agentic AI 都碰一點），建議順序是：

1. 方向三的「問題 1」（agent 依賴）— 低成本、高體感提升。
2. 方向二的「步驟 1」（CloudWatch alarms）— 純 Terraform，跟其他改動沒有耦合，
   隨時可以加。
3. 方向一的「步驟 1-3」（research topics + symbol metadata + invoke_researcher）—
   把上週和這週的工作真正串起來，是這次作業最具「整合感」的部分。
4. 時間夠的話再做方向二的「步驟 3」（品質漂移追蹤）跟方向三的「問題 3/4」
   （Polygon 工具 + deep research）。

完成後記得依照課程要求，在 production repo 的 community contributions 資料夾
放一份 markdown 或 notebook 寫你做了什麼、為什麼這麼做、效果如何（前後報告品質的
對比截圖會很有說服力），如果做成可訂閱的產品就直接給連結，不用附原始碼。
