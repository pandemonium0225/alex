# 從「按下分析」到「畫面顯示結果」：Alex 完整請求流程逐步解析

> 給初學者的逐步教學文件。目標：讀完這份文件後，你能夠獨立畫出 Alex 從前端按鈕到
> 後端多代理人（multi-agent）協作、呼叫 Bedrock 模型、寫回資料庫、最後顯示在畫面上
> 的完整資料流，並理解每一步背後的程式設計觀念，未來能套用到自己的專案。

---

## 0. 總覽：一張圖看完整流程

```
[使用者] 按下「Start New Analysis」按鈕 (advisor-team.tsx)
   │  fetch POST /api/analyze  (帶 Clerk JWT)
   ▼
[FastAPI 後端] backend/api/main.py: trigger_analysis()
   │  1) 在 Aurora 寫入一筆 jobs 資料, status='pending'
   │  2) 把 job_id 包成訊息丟進 SQS 佇列
   │  3) 立刻回應 {job_id} 給前端 (非同步！不會等分析做完才回應)
   ▼
[前端] 開始每 2 秒 poll GET /api/jobs/{job_id}，直到 status 變成 completed/failed
   │
   ▼ (背景，跟前端 polling 完全平行發生)
[SQS 佇列] analysis_jobs queue
   │  觸發 (event source mapping) →
   ▼
[Planner Lambda] backend/planner/lambda_handler.py
   │  asyncio.run(run_orchestrator(job_id))
   │  1) 前處理：補齊缺資料的標的 (呼叫 Tagger Lambda)、更新股價
   │  2) 建立 Agent (OpenAI Agents SDK) + LitellmModel(bedrock/...)
   │  3) Runner.run(agent, ...) → LLM 決定呼叫哪些工具 (function tools)
   ▼
   ├─→ invoke_reporter 工具 → 同步呼叫 Reporter Lambda → 寫 report_payload
   ├─→ invoke_charter  工具 → 同步呼叫 Charter  Lambda → 寫 charts_payload
   └─→ invoke_retirement 工具 → 同步呼叫 Retirement Lambda → 寫 retirement_payload
   │
   ▼ (三個都做完、LLM 回 "Done" 後)
[Planner] db.jobs.update_status(job_id, "completed")
   ▼
[前端] polling 偵測到 completed → 導向 /analysis?job_id=xxx
   ▼
[Analysis 頁面] GET /api/jobs/{job_id} → 取出整筆 job (含三個 payload)
   → ReactMarkdown 渲染報告文字、Recharts 畫圖表、Markdown 渲染退休分析
```

關鍵心智模型：**這是一個「非同步任務佇列」架構**，前端發出請求後立刻拿到 `job_id`，
不會卡住等待；真正耗時的 LLM 運算在背景的 Lambda 鏈裡進行；前端用「輪詢
(polling)」追蹤進度。這跟一般 REST API「請求 → 立刻回應結果」的同步模式不同，
是處理「需要幾十秒甚至幾分鐘」的工作時的標準解法。

---

## Step 1：使用者按下按鈕，前端發出分析請求

**檔案：** `frontend/pages/advisor-team.tsx:178-234`（`startAnalysis` 函式）

```tsx
const startAnalysis = async () => {
  setIsAnalyzing(true);
  setProgress({ stage: 'starting', message: 'Initializing analysis...', activeAgents: [] });

  const token = await getToken();
  const response = await fetch(`${API_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ analysis_type: 'portfolio', options: {} })
  });

  if (response.ok) {
    const data = await response.json();
    setCurrentJobId(data.job_id);          // 觸發下面 Step 4 的 polling useEffect
    emitAnalysisStarted(data.job_id);
    setProgress({ stage: 'planner', message: 'Financial Planner coordinating analysis...', ... });
  }
};
```

**值得注意的地方：**

1. `getToken()` 來自 Clerk 的 `useAuth()` hook，回傳的是當前登入使用者的 **JWT**。
   每一個對後端的請求都帶上 `Authorization: Bearer <token>`，後端用這個 JWT 來驗證
   身份並取出 `clerk_user_id`（見 Step 2）。
2. `setCurrentJobId(data.job_id)` 只是把 state 存起來——這個動作會觸發另一個
   `useEffect`（Step 4）開始輪詢，這是 React 用 state 變化驅動副作用的典型寫法。
3. UI 上的 `progress.stage` 的進場時間（`setTimeout(..., 5000)` 切到 `'parallel'`）
   是**前端自己用時間猜的動畫效果**，跟後端真實進度無關——這只是體驗上的視覺提示，
   真正的完成狀態還是要靠 Step 4 的 polling 結果決定。

---

## Step 2：FastAPI 後端建立工作（Job），丟進 SQS

**檔案：** `backend/api/main.py:524-612`（`trigger_analysis` endpoint）

```python
@app.post("/api/analyze", response_model=AnalyzeResponse)
async def trigger_analysis(request: AnalyzeRequest, clerk_user_id: str = Depends(get_current_user_id)):
    user = db.users.find_by_clerk_id(clerk_user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # 1) 在資料庫建立一筆 job，初始 status='pending'
    job_id = db.jobs.create_job(
        clerk_user_id=clerk_user_id,
        job_type="portfolio_analysis",
        request_payload=request.model_dump()
    )

    # 2) 把 job_id 丟進 SQS，讓背景的 Planner Lambda 之後處理
    if SQS_QUEUE_URL:
        message = {'job_id': str(job_id), 'clerk_user_id': clerk_user_id,
                    'analysis_type': request.analysis_type, 'options': request.options}
        sqs_client.send_message(QueueUrl=SQS_QUEUE_URL, MessageBody=json.dumps(message))

    # 3) 立刻回應，不等分析跑完
    return AnalyzeResponse(job_id=str(job_id), message="Analysis started. Check job status for results.")
```

**值得注意的地方：**

1. `Depends(get_current_user_id)` 是 FastAPI 的依賴注入機制：在進入這個函式之前，
   FastAPI 會先執行 `get_current_user_id`，裡面用 `ClerkHTTPBearer` 驗證 JWT，驗證
   失敗就直接回 401，根本不會進到函式內部。這是「在邊界驗證」的具體案例。
2. `db.jobs.create_job(...)` 對應到 `backend/database/src/models.py:224-233`：

   ```python
   def create_job(self, clerk_user_id, job_type, request_payload=None) -> str:
       data = {'clerk_user_id': clerk_user_id, 'job_type': job_type,
                'status': 'pending', 'request_payload': request_payload}
       return self.db.insert(self.table_name, data, returning='id')
   ```
   這一步是整個分析流程「唯一一筆真正同步、立刻發生」的資料庫寫入——之後所有
   Lambda 對這筆 job 的更新都是非同步背景發生的。
3. **SQS 是這個架構解耦的關鍵**：API 後端不知道、也不在乎 Planner Lambda 什麼時候
   執行、跑多久。它只負責「把工作放進佇列」，job 處理完全交給訂閱這個佇列的 Lambda。
   這讓 API 回應永遠是毫秒級的，不會因為 LLM 呼叫卡住整個 HTTP 連線。
4. `if SQS_QUEUE_URL:` 的防呆設計——如果還沒設定佇列（例如剛開始學 Guide 5/6 的
   學生），job 還是會被建立，只是不會被處理，並記 log 警告而不是直接報錯。

---

## Step 3：SQS 佇列把訊息派送給 Planner Lambda

**檔案：** `terraform/6_agents/main.tf:266-268`

```hcl
# SQS trigger for Planner
resource "aws_lambda_event_source_mapping" "planner_sqs" {
  event_source_arn = aws_sqs_queue.analysis_jobs.arn
  function_name     = aws_lambda_function.planner.function_name
  ...
}
```

**值得注意的地方：**

1. 這段 **Terraform** 設定的是「事件來源對應 (event source mapping)」——AWS 會自動
   幫你跑一個輪詢機制，持續檢查 SQS 佇列有沒有新訊息，有的話就用
   `InvocationType=Event`（非同步）呼叫 Planner Lambda，並把訊息包成
   `event['Records'][0]['body']` 的格式傳進去。**這段邏輯你完全不用寫**，是 AWS
   代管的基礎設施，這也是為什麼 Lambda 程式碼裡會看到「處理 SQS 格式」的程式碼
   （見 Step 4）。
2. 這就是課程文件裡反覆強調「檢查 `terraform.tfvars`、檢查資源是否真的部署」的
   原因——如果這個 event source mapping 沒有正確建立，job 永遠停在 `pending`，
   前端會一直 polling 但狀態不會改變，而且**不會有任何明顯的錯誤訊息**。

---

## Step 4：前端開始輪詢工作狀態

**檔案：** `frontend/pages/advisor-team.tsx:85-158`

```tsx
useEffect(() => {
  const checkJobStatusLocal = async (jobId: string) => {
    const response = await fetch(`${API_URL}/api/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const job = await response.json();

    if (job.status === 'completed') {
      clearInterval(pollInterval);
      emitAnalysisCompleted(jobId);
      setTimeout(() => router.push(`/analysis?job_id=${jobId}`), 1500);
    } else if (job.status === 'failed') {
      clearInterval(pollInterval);
      // 顯示錯誤訊息
    }
  };

  if (currentJobId && !pollInterval) {
    const interval = setInterval(() => checkJobStatusLocal(currentJobId), 2000);
    setPollInterval(interval);
  }

  return () => { if (pollInterval) clearInterval(pollInterval); };
}, [currentJobId, pollInterval, router]);
```

**值得注意的地方：**

1. **這是「短輪詢 (short polling)」模式**：每 2 秒重新發一次 HTTP 請求問後端
   「現在狀態如何？」。優點是實作簡單、不需要 WebSocket 或 Server-Sent Events；
   缺點是有延遲（最多 2 秒才會發現完成）、且會持續產生 API 請求流量。對這種
   「分析通常要 10-60 秒」的場景，這個取捨是合理的。
2. `useEffect` 回傳的清理函式（`return () => clearInterval(...)`）非常重要——
   如果使用者離開頁面或元件重新渲染卻沒清掉舊的 `setInterval`，會造成「殭屍輪詢」
   持續發送請求，這是 React 處理副作用清理的標準寫法。
3. 真正觸發頁面跳轉的，不是後端推播，而是**前端主動發現狀態改變**——這跟一般
   「伺服器主動通知」的直覺不同，初學者常會誤以為背後有某種推播機制。

---

## Step 5：Planner Lambda 被觸發，解析 job_id

**檔案：** `backend/planner/lambda_handler.py:173-223`（`lambda_handler`）

```python
def lambda_handler(event, context):
    with observe():
        try:
            # 從 SQS 訊息格式取出 job_id
            if 'Records' in event and len(event['Records']) > 0:
                job_id = event['Records'][0]['body']
                if isinstance(job_id, str) and job_id.startswith('{'):
                    body = json.loads(job_id)
                    job_id = body.get('job_id', job_id)
            elif 'job_id' in event:
                job_id = event['job_id']   # 直接呼叫測試用
            else:
                return {'statusCode': 400, 'body': json.dumps({'error': 'No job_id provided'})}

            asyncio.run(run_orchestrator(job_id))   # 見 Step 6

            return {'statusCode': 200, 'body': json.dumps({'success': True, ...})}
        except Exception as e:
            return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': str(e)})}
```

**值得注意的地方：**

1. **AWS Lambda 規定 handler 的呼叫方式是同步的** (`handler(event, context)`，沒有
   `await`)。Lambda 的 Python runtime bootstrap 並不會去 `await` 你的函式，所以
   `lambda_handler` 本身**必須是普通 `def`，不能是 `async def`**——否則呼叫它只會
   拿到一個「還沒執行」的 coroutine 物件，而不是真正執行完的結果，序列化回應時
   就會出錯。這就是為什麼程式碼內部要手動呼叫 `asyncio.run(...)` 來「橋接」進入
   asyncio 的世界，讓內部可以放心用 `async def`、`await` 寫非同步邏輯。
2. 同一支程式碼**同時支援兩種呼叫方式**：正式環境是 SQS 觸發（`'Records' in event`），
   本地測試或手動觸發則是直接傳 `{'job_id': '...'}`（`'job_id' in event`）。這種
   雙路徑判斷讓同一份程式碼在 `test_simple.py` / `test_full.py`、以及正式 SQS
   情境下都能跑，不用為了測試另外寫一份。
3. `with observe():` 包住整個處理流程——這是 LangFuse/Logfire 的 observability
   context manager（細節見 Step 9 補充說明），目的是確保不管成功或失敗，
   trace 資料都會被送出。

---

## Step 6：`run_orchestrator` 前處理：補資料、更新股價

**檔案：** `backend/planner/lambda_handler.py:62-103`

```python
async def run_orchestrator(job_id: str) -> None:
    job = db.jobs.find_by_id(job_id)
    user_id = job["clerk_user_id"]

    db.jobs.update_status(job_id, 'running')   # pending → running

    # 1) 檢查並補標的的資產配置資料（呼叫 Tagger Lambda）
    await asyncio.to_thread(handle_missing_instruments, job_id, db)

    # 2) 更新股價（呼叫外部市場資料 API）
    await asyncio.to_thread(update_instrument_prices, job_id, db)

    # 3) 算出簡單的投資組合摘要統計（只是統計數字，不是完整持股明細）
    portfolio_summary = await asyncio.to_thread(load_portfolio_summary, job_id, db)
    ...
```

**值得注意的地方：**

1. `db.jobs.update_status(job_id, 'running')` 是前端 polling 看到的第二個狀態。
   完整的狀態機是：`pending → running → completed` 或 `pending → running → failed`。
2. **`asyncio.to_thread(fn, *args)` 在做什麼？** `handle_missing_instruments`、
   `update_instrument_prices`、`load_portfolio_summary` 都是「同步」函式（內部用
   一般的 `requests`/`boto3` 呼叫，沒有 `async def`）。把它們丟進
   `asyncio.to_thread`，是讓這段**阻塞 (blocking) 的 I/O 工作**在背景執行緒池跑，
   而不會卡住目前的 asyncio event loop。注意：
   - 這**不會讓函式本身變成非同步**——它執行的方式完全沒變，只是換了一個執行緒執行。
   - 變成非阻塞的是「呼叫者」的 `await`，不是「被呼叫函式」的本質。
   - 在這個專案裡，因為每個 Lambda 容器同時只處理一個 job，這裡用 thread pool
     主要是為了程式碼風格一致（全部用 `async/await` 串起來），而不是為了真正的
     平行運算。
3. `load_portfolio_summary` 故意**只回傳統計數字**（總值、持倉數、退休年限等），
   不把完整的持股明細塞進 LLM 的 prompt——這是控制 token 用量、降低成本與延遲的
   實務考量：Planner agent 不需要知道每一筆持股細節，只需要知道「有沒有東西可以
   分析」就能決定呼叫哪些工具。

---

## Step 7：建立 Agent，準備呼叫 Bedrock 模型

**檔案：** `backend/planner/agent.py:318-344`（`create_agent`）

```python
def create_agent(job_id: str, portfolio_summary: Dict[str, Any], db):
    context = PlannerContext(job_id=job_id)

    model_id = os.getenv("BEDROCK_MODEL_ID", "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
    bedrock_region = os.getenv("BEDROCK_REGION", "us-west-2")
    os.environ["AWS_REGION_NAME"] = bedrock_region     # LiteLLM 認這個變數名稱！

    model = LitellmModel(model=f"bedrock/{model_id}")

    tools = [invoke_reporter, invoke_charter, invoke_retirement]

    task = f"""Job {job_id} has {portfolio_summary['num_positions']} positions.
Retirement: {portfolio_summary['years_until_retirement']} years.
Call the appropriate agents."""

    return model, tools, task, context
```

**值得注意的地方：**

1. `LitellmModel(model=f"bedrock/{model_id}")` 是 OpenAI Agents SDK 透過
   **LiteLLM** 這個轉接層去呼叫 AWS Bedrock——OpenAI Agents SDK 原生是設計給
   OpenAI 的模型用的，LiteLLM 在這裡的作用是把呼叫格式轉換成 Bedrock 能理解的
   API 呼叫，讓你可以用同一套 Agent 程式碼切換不同的底層模型供應商。
2. `os.environ["AWS_REGION_NAME"] = bedrock_region`——**這行特別容易踩坑**。
   一般 AWS SDK（boto3）認的是 `AWS_REGION` 或 `AWS_DEFAULT_REGION`，但 LiteLLM
   呼叫 Bedrock 時，文件規定要用 `AWS_REGION_NAME` 這個變數名稱，三者意義相近卻
   是不同的環境變數，沒設對就會打到錯的 region，或在跨區 Bedrock inference
   profile 情境下出現權限錯誤。
3. **這裡只是「準備」模型物件和工具清單，還沒有真正呼叫 LLM**——真正打 API
   的動作發生在下一步的 `Runner.run(...)`。`create_agent` 回傳的 `model` 只是
   一個設定好的物件，類似你準備好一支已經裝好彈夾的槍，扣下扳機（呼叫
   `Runner.run`）才會真正發射。

---

## Step 8：`Runner.run` 真正呼叫模型，LLM 決定呼叫哪些工具

**檔案：** `backend/planner/lambda_handler.py:108-141`

```python
with trace("Planner Orchestrator"):
    agent = Agent[PlannerContext](
        name="Financial Planner",
        instructions=ORCHESTRATOR_INSTRUCTIONS,
        model=model,
        tools=tools
    )

    result = await Runner.run(agent, input=task, context=context, max_turns=20)
```

對應的指令模板（**檔案：** `backend/planner/templates.py`）：

```python
ORCHESTRATOR_INSTRUCTIONS = """You coordinate portfolio analysis by calling other agents.

Tools (use ONLY these three):
- invoke_reporter: Generates analysis text
- invoke_charter: Creates charts
- invoke_retirement: Calculates retirement projections

Steps:
1. Call invoke_reporter if positions > 0
2. Call invoke_charter if positions >= 2
3. Call invoke_retirement if retirement goals exist
4. Respond with "Done"
"""
```

**值得注意的地方：**

1. `Agent[PlannerContext](...)` 的型別參數 `[PlannerContext]` 是 OpenAI Agents
   SDK 用來在「工具 (tool) 函式」裡安全取得非 LLM 控制的資料（這裡是
   `job_id`）的方式——LLM 本身完全不知道、也不需要知道 `job_id` 是什麼，它只負責
   「決定要不要呼叫某個工具」，工具實際執行時才透過 `RunContextWrapper` 拿到
   `context.job_id`（見下方 `invoke_reporter` 的程式碼）。
2. **`Runner.run(...)` 才是真正打 Bedrock API 的地方**：它會把
   `instructions` + `input=task` 組成一個 prompt 送給模型，模型（Claude／Nova Pro）
   讀完之後決定「我要呼叫 `invoke_reporter`」這個 function tool，OpenAI Agents SDK
   收到模型的工具呼叫請求後，會在背景**真正執行** Python 裡對應的
   `invoke_reporter` 函式，把回傳結果再送回模型，模型再決定下一步——這個
   「模型 ↔ 工具」的來回，就是 `max_turns=20` 限制的「對話輪數」上限，避免
   LLM 無限循環呼叫工具耗費成本。
3. `instructions` 寫得非常精簡、條列式（「只能用這三個工具」「依序做什麼」），
   這是 prompt engineering 的實務經驗：對於只是要做「決策性協調」的 agent，
   指令越精確、限制越明確，越不容易讓 LLM 偏離預期行為或呼叫不該呼叫的工具。

工具本身的程式碼（**檔案：** `backend/planner/agent.py:302-316`）：

```python
@function_tool
async def invoke_reporter(wrapper: RunContextWrapper[PlannerContext]) -> str:
    """Invoke the Report Writer agent to generate portfolio analysis narrative."""
    return await invoke_reporter_internal(wrapper.context.job_id)
```

**值得注意的地方：**

- `@function_tool` 這個裝飾器（decorator）會自動把這個 Python 函式的「函式名稱」
  和「docstring」轉換成 LLM 能理解的工具描述（schema），模型就是靠讀這段
  docstring（"Invoke the Report Writer agent..."）來判斷「這個工具是做什麼的、
  什麼時候該呼叫它」。**docstring 不只是給人看的註解，也是 LLM 決策的依據**，
  這跟一般寫程式時 docstring「純粹是說明文件」的角色不太一樣。

---

## Step 9：工具呼叫真正觸發另一個 Lambda（跨服務呼叫）

**檔案：** `backend/planner/agent.py:57-130`（`invoke_lambda_agent`）

```python
lambda_client = boto3.client("lambda")

async def invoke_lambda_agent(agent_name, function_name, payload):
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",   # 同步呼叫，等對方做完才回來
        Payload=json.dumps(payload),
    )
    result = json.loads(response["Payload"].read())

    # Lambda 標準回應格式 {statusCode, body} 要解開一層
    if isinstance(result, dict) and "statusCode" in result and "body" in result:
        result = json.loads(result["body"]) if isinstance(result["body"], str) else result["body"]

    return result
```

**值得注意的地方：**

1. `InvocationType="RequestResponse"` 是**同步**呼叫 Lambda 的方式——Planner
   會一直等到 Reporter/Charter/Retirement Lambda 整個執行完（包含它們各自的
   LLM 呼叫！）才拿到回應、才能繼續下一步。這跟前面 SQS→Planner 的觸發方式
   （非同步事件）形成對比：**SQS 觸發是「射後不理」，Lambda 互相呼叫這裡是
   「打了等回應」**。代價是 Planner Lambda 的總執行時間 = 自己的時間 +
   三個子 agent 各自的時間加總（因為 Planner 的 instructions 是依序呼叫工具，
   不是同時平行呼叫，所以前端 UI 上「Agents working in parallel」其實只是
   視覺效果，後端實際上是**序列**執行的）。
2. `MOCK_LAMBDAS` 環境變數（`backend/planner/agent.py:26`）讓你在本地開發、跑
   `test_simple.py` 時完全不用真的部署或呼叫任何 Lambda，直接回傳一個假的
   成功訊息——這是課程建議「先用 mock 在本地測，再部署測真的」流程背後的程式碼
   依據。
3. `log_agent_invocation_event(...)` 把每一次跨 Lambda 呼叫的開始、結束、失敗
   都寫成結構化 JSON log，方便之後用 CloudWatch Logs Insights 查詢——這對應
   guides/9 文件裡提到的「可觀測性 (observability)」實踐。

---

## Step 10：子 Agent 各自呼叫模型、處理結果、寫回資料庫

三個子 agent 的模式略有不同，但核心結構一致：建立模型 → `Runner.run` →
拿 `result.final_output` → 存進資料庫。

### 10a. Reporter（產生文字報告，有工具）

**檔案：** `backend/reporter/lambda_handler.py:45-102`

```python
async def run_reporter_agent(job_id, portfolio_data, user_data, db, observability):
    model, tools, task, context = create_agent(job_id, portfolio_data, user_data, db)

    with trace("Reporter Agent"):
        agent = Agent[ReporterContext](name="Report Writer", instructions=REPORTER_INSTRUCTIONS,
                                         model=model, tools=tools)
        result = await Runner.run(agent, input=task, context=context, max_turns=10)
        response = result.final_output

        # 品質守門：用另一個 LLM 當「評審」幫這份報告打分
        if observability:
            evaluation = await evaluate(REPORTER_INSTRUCTIONS, task, response)
            score = evaluation.score / 100
            if score < GUARD_AGAINST_SCORE:   # 0.3
                response = "I'm sorry, I'm not able to generate a report for you. Please try again later."

        report_payload = {"content": response, "generated_at": ..., "agent": "reporter"}
        db.jobs.update_report(job_id, report_payload)
```

Reporter 唯一的工具（**檔案：** `backend/reporter/agent.py:133-243`）會去查
**S3 Vectors 向量資料庫**：

```python
@function_tool
async def get_market_insights(wrapper, symbols):
    # 1) 把查詢字串送進 SageMaker embedding endpoint，轉成向量
    embedding = sagemaker.invoke_endpoint(EndpointName=..., Body=json.dumps({"inputs": query}))
    # 2) 拿這個向量去 S3 Vectors 做相似度搜尋，找最相關的市場研究片段
    response = s3v.query_vectors(vectorBucketName=bucket, indexName="financial-research",
                                   queryVector={"float32": embedding}, topK=3)
    return "Market Insights:\n" + ...
```

**值得注意的地方：**

1. **這是一個 RAG（Retrieval-Augmented Generation）的具體實作**：LLM 自己決定
   「我需要查市場資料」→ 呼叫 `get_market_insights` 工具 → 工具把文字轉成向量
   （embedding）→ 拿向量去做語意搜尋 → 把搜尋到的真實研究片段塞回給 LLM 當
   參考資料 → LLM 根據這些真實資料寫報告，而不是純粹憑訓練知識「幻想」市場狀況。
2. **品質守門（guardrail）模式**：產生報告後，不是直接存進資料庫，而是先送給
   一個獨立的「評審」LLM 呼叫（`evaluate(...)`）打分，分數太低（< 0.3）就**整個
   丟棄**，回一個道歉訊息給使用者，而不是把品質不佳的內容存進資料庫——這是
   guides/9 文件裡 Direction 2（MLOps／品質監控）談到的具體落地案例。
3. `db.jobs.update_report(job_id, report_payload)` 對應
   `backend/database/src/models.py:249-252`：

   ```python
   def update_report(self, job_id, report_payload):
       return self.db.update('jobs', {'report_payload': report_payload}, "id = :id::uuid", {'id': job_id})
   ```
   `report_payload` 在資料庫裡存的是一個 JSON 欄位（PostgreSQL `jsonb`），前端
   `analysis.tsx` 直接讀 `job.report_payload.content` 當作 Markdown 字串渲染。

### 10b. Charter（產生圖表資料，無工具，直接輸出 JSON）

**檔案：** `backend/charter/lambda_handler.py:35-126`

```python
async def run_charter_agent(job_id, portfolio_data, db):
    model, task = create_agent(job_id, portfolio_data, db)   # 注意：沒有 tools

    with trace("Charter Agent"):
        agent = Agent(name="Chart Maker", instructions=CHARTER_INSTRUCTIONS, model=model)
        result = await Runner.run(agent, input=task, max_turns=5)
        output = result.final_output

        # 手動從文字輸出中找出 JSON 物件並解析
        start_idx = output.find('{')
        end_idx = output.rfind('}')
        parsed_data = json.loads(output[start_idx:end_idx + 1])
        charts = parsed_data.get('charts', [])

        charts_data = {chart['key']: {k: v for k, v in chart.items() if k != 'key'} for chart in charts}
        db.jobs.update_charts(job_id, charts_data)
```

**值得注意的地方：**

1. 在這個專案的開發者注意事項裡明確提到：**因為 LiteLLM 呼叫 Bedrock 目前有個
   限制——同一個 Agent 不能同時用「Structured Outputs」又用「Tool calling」**。
   Charter 選擇放棄工具，改成在 `instructions` 裡明確要求模型「直接輸出 JSON
   格式文字」，然後**自己手動找 `{` 和 `}` 把 JSON 字串切出來解析**——這是相對
   原始（土法煉鋼）但在限制條件下務實的做法，而不是用 SDK 內建的
   `output_type` 結構化輸出機制。
2. 因為輸出格式是「自由文字裡藏一段 JSON」，這裡的程式碼必須容錯：
   `json.JSONDecodeError` 要 catch、找不到 `{` 也要處理——這提醒我們，**讓 LLM
   產生結構化資料時，呼叫端永遠要假設輸出可能不完全符合預期格式**，這是跟一般
   呼叫穩定的內部函式很不一樣的心態。
3. `charts_data` 最後存成「以 chart 名稱為 key 的字典」，正好對應前端
   `analysis.tsx:340` 的 `Object.entries(chartsPayload)`，前端完全不用知道有
   幾種圖表類型，動態跑迴圈渲染——前後端透過這個資料結構約定（contract）解耦。

### 10c. Retirement（退休試算，先用 Python 算 Monte Carlo，再請 LLM 寫分析）

**檔案：** `backend/retirement/agent.py:236-324`、`backend/retirement/lambda_handler.py`

```python
def create_agent(job_id, portfolio_data, user_preferences, db):
    model = LitellmModel(model=f"bedrock/{model_id}")

    # 先用純 Python 做 500 次蒙地卡羅模擬（完全不靠 LLM）
    monte_carlo = run_monte_carlo_simulation(portfolio_value, years_until_retirement,
                                               target_income, allocation, num_simulations=500)
    projections = generate_projections(portfolio_value, years_until_retirement, allocation, current_age)

    tools = []   # 不給工具，LLM 只負責「解讀」已經算好的數字
    task = f"""
## Monte Carlo Simulation Results (500 scenarios)
- Success Rate: {monte_carlo["success_rate"]}%
...
Your task: Analyze this retirement readiness data and provide a comprehensive retirement analysis...
"""
    return model, tools, task
```

**值得注意的地方：**

1. 這是三個子 agent 裡**最該注意「LLM 用在哪裡」的案例**：真正的數值運算
   （500 次蒙地卡羅模擬、機率統計）完全用確定性的 Python 程式碼算出來，LLM
   只負責**把算好的數字「解讀成人話」**並給建議——這是業界很常見的模式：
   不確定性高、需要「理解上下文給建議」的部分交給 LLM；需要精確、可重現、
   大量重複運算的部分交給傳統程式碼。如果讓 LLM 自己「想像」蒙地卡羅模擬的結果，
   準確性和可重現性都會是問題。
2. `tools = []`——這個 agent 完全沒有工具，`Runner.run` 一次來回就結束
   （模型不會多輪呼叫工具，直接針對 `task` 裡給的數據寫分析），這也是為什麼
   `max_turns=20` 在這裡其實用不太到，主要是保留與其他 agent 一致的程式碼風格。
3. `retirement_payload = {'analysis': result.final_output, ...}`——欄位名稱
   叫 `analysis`（不是像 Reporter 用 `content`），對應前端
   `analysis.tsx:445/455` 讀的是 `job.retirement_payload.analysis`。**前後端
   欄位名稱必須完全對齊**，這種命名約定沒有強制型別檢查保護，是純靠團隊規範
   維持一致——這也是為什麼 `frontend/components/ErrorBoundary.tsx` 等前端防護
   機制很重要：萬一後端欄位改了名字，前端至少不會整頁白屏崩潰。

---

## Step 11：三個子 agent 都做完，Planner 標記工作完成

回到 `backend/planner/lambda_handler.py:130-145`：

```python
result = await Runner.run(agent, input=task, context=context, max_turns=20)
# result.final_output 此時應該是 "Done"（依照 ORCHESTRATOR_INSTRUCTIONS 的指示）

db.jobs.update_status(job_id, "completed")
logger.info(f"Planner: Job {job_id} completed successfully")
```

**值得注意的地方：**

1. 整個 Planner 的 `Runner.run` 呼叫，**直到它裡面呼叫的三個 `invoke_lambda_agent`
   全部跑完才會返回**——因為 Step 9 提到的 `InvocationType="RequestResponse"`
   是同步等待。換句話說，"Planner Lambda 完成" 這件事，實際上代表「Reporter、
   Charter、Retirement 三個 Lambda 都已經各自呼叫了一次 Bedrock 並把結果存進
   資料庫」。
2. 如果中途任何一步丟出例外，會被外層的 `except Exception as e:`
   （`lambda_handler.py:157-171`）捕捉，呼叫
   `db.jobs.update_status(job_id, 'failed', error_message=str(e))`，前端的
   polling 邏輯（Step 4）會看到 `status === 'failed'` 並顯示錯誤訊息——這個
   try/except 包住「整個 orchestration 流程」而不是每一步分別 try/except，
   是刻意的設計：**任何一步失敗，整個 job 就該標記失敗**，不需要嘗試「部分成功」
   的複雜狀態。

---

## Step 12：前端偵測完成，導向結果頁面

回到 Step 4 的 `checkJobStatusLocal`：偵測到 `job.status === 'completed'` 後

```tsx
emitAnalysisCompleted(jobId);
setTimeout(() => router.push(`/analysis?job_id=${jobId}`), 1500);
```

**值得注意的地方：**

- `setTimeout(..., 1500)` 故意延遲 1.5 秒才跳轉，讓使用者先看到「Analysis
  complete!」的提示動畫，純粹是 UX 考量，沒有技術上的必要性。

---

## Step 13：Analysis 頁面載入，渲染三種結果

**檔案：** `frontend/pages/analysis.tsx:67-134`

```tsx
useEffect(() => {
  const loadJob = async (jobId: string) => {
    const token = await getToken();
    const response = await fetch(`${API_URL}/api/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const jobData = await response.json();
    setJob(jobData);   // jobData 裡同時包含 report_payload / charts_payload / retirement_payload
  };

  if (job_id) loadJob(job_id as string);
  else if (router.isReady) loadLatestJob();   // 沒帶 job_id 時自動找最新一筆完成的分析
}, [job_id, router.isReady, getToken, router]);
```

對應後端（**檔案：** `backend/api/main.py:614-634`）：

```python
@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str, clerk_user_id: str = Depends(get_current_user_id)):
    job = db.jobs.find_by_id(job_id)
    if job.get('clerk_user_id') != clerk_user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return job
```

三個分頁分別渲染（**檔案：** `frontend/pages/analysis.tsx:247-482`）：

| 分頁 | 資料來源 | 渲染方式 |
|---|---|---|
| Overview | `job.report_payload.content`（Markdown 字串） | `<ReactMarkdown>` |
| Charts | `job.charts_payload`（動態 key 的圖表設定字典） | 依 `chartData.type` 動態決定 `<PieChart>`／`<BarChart>`／`<LineChart>`（Recharts） |
| Retirement Projection | `job.retirement_payload.analysis`（Markdown 字串） | `<ReactMarkdown>` |

**值得注意的地方：**

1. **這支 API 一次回傳整筆 job**（所有 payload 都在同一個 HTTP response 裡），
   而不是前端對三個分頁分別發三個請求——因為這三份資料本來就是同一個 job 的
   產物，存在同一張資料表的同一筆 row 裡（`jobs` 表有
   `report_payload`/`charts_payload`/`retirement_payload` 三個 `jsonb` 欄位），
   一次查、一次回應是最自然的設計。
2. `if (account.get('clerk_user_id') != clerk_user_id): raise HTTPException(403)`
   ——**這是整個流程中最重要的安全檢查之一**：光是 JWT 驗證身份還不夠，還要
   確認「這個 job 真的是這個使用者自己的」，否則只要猜得到別人的 `job_id`，就能
   讀到別人的投資組合分析。這個模式（先查資料，再比對 ownership）在
   `main.py` 裡的 accounts／positions endpoints 也反覆出現，是一致的安全模式。
3. `getChartType(chartData)` 在前端做了一層「智慧猜測」：如果 Charter agent
   沒有明確指定圖表類型，就根據資料形狀（有沒有日期欄位、資料筆數多寡）猜一個
   合理的圖表類型——這是「後端盡量給足資訊，前端做合理的 fallback」的防禦性
   設計，避免後端 LLM 偶爾漏給欄位就整個圖表渲染失敗。

---

## 總結：貫穿全流程的五個核心設計觀念

1. **非同步任務佇列模式**：API 接到請求立刻回應 `job_id`，真正運算在背景
   Lambda 鏈裡發生，前端用輪詢追蹤進度。適用於「處理時間不確定、可能較長」
   的工作（這裡是多次 LLM 呼叫）。
2. **多代理人（multi-agent）協作 = 一個 Orchestrator + 多個專家 Lambda**：
   Planner 本身是一個 agent，但它的「工具」不是查資料或算數字，而是「呼叫
   另一個完整的 agent（另一個 Lambda）」。LLM 在 Planner 層只負責**決策要不要
   呼叫誰**，不負責真正執行；真正的領域邏輯（寫報告、做圖表、退休試算）分散在
   各自的子 Lambda 裡。
3. **LLM 用在「不確定性高、需要理解與表達」的環節，傳統程式碼用在「確定性高、
   需要精確與可重現」的環節**：退休試算的蒙地卡羅模擬是純 Python，LLM 只負責
   解讀數字給建議；Charter 的圖表資料格式靠 prompt 引導 LLM 輸出，但解析靠
   傳統字串/JSON 處理。
4. **資料契約（contract）靠欄位命名與型別 schema 維持，沒有強制檢查**：前端
   讀 `report_payload.content`、`retirement_payload.analysis`，後端就要存對
   應的欄位名稱；這類隱性契約是團隊規範問題，不是編譯器/型別系統能完全保護的。
5. **每一層都要驗證身份與資料歸屬（ownership）**：JWT 驗證「你是誰」，
   `clerk_user_id` 比對驗證「這份資料是不是你的」，兩者缺一不可。

---

## 給初學者：如果你想寫類似的系統，從這裡開始

1. 先搞懂「同步 API 呼叫」與「非同步任務佇列」的差異，決定你的功能屬於哪一種。
2. 如果要做「LLM 決定呼叫工具」的 agent，先寫一個只有 1-2 個工具的最小版本，
   把 `instructions` 寫得越具體越好（像 `ORCHESTRATOR_INSTRUCTIONS` 那樣條列式），
   再逐步增加工具數量。
3. 永遠假設 LLM 的輸出可能不符合預期格式——如果可以用 SDK 的結構化輸出
   (`output_type`) 就優先用；如果像本專案這樣有平台限制必須自己解析文字，
   一定要包好 try/except。
4. 把「確定性運算」與「LLM 解讀/生成」分開寫成不同函式——這樣測試時可以
   分別驗證數值計算的正確性，和 LLM 輸出的合理性，不會混在一起難以除錯。
5. 任何跨服務、跨 Lambda 的呼叫都要記 log（事件開始、結束、失敗），出問題時
   CloudWatch Logs 會是你唯一的線索來源。
