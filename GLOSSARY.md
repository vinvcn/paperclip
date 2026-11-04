# Paperclip Usage（LLM 请求日志与用量统计）

Usage 页面的领域词汇：一次 LLM 请求是什么、App 指什么、统计口径如何定义。

## Language

**Request（请求）**：
一次发往模型 API 的 HTTP 调用；tool loop 中每次模型调用各算一次。
_Avoid_: 调用、turn、run

**Turn（回合）**：
agent 的一次回复周期，内部可能包含多次 Request；现有 cost receipt 的粒度。
_Avoid_: step、请求

**Run（运行）**：
一次 heartbeat 执行，包含一个或多个 Turn。
_Avoid_: session、job

**App（应用）**：
产生请求的 harness：opencode、codex、claude 等。
_Avoid_: provider、产品名、agent

**Provider（提供商）**：
模型 API 的供应商（NVIDIA NIM、OpenRouter、Anthropic 等）。
_Avoid_: 用 App 指代 provider

**Usage（用量）**：
请求级日志与 token/成本统计的视图；与财务视角的 Costs 区分。
_Avoid_: 成本页、账单

**Fresh Input（新鲜输入）**：
未命中缓存的输入 token 数（input − cachedInput）。
_Avoid_: 输入 token

**Cache Hit Rate（缓存命中率）**：
cachedInput ÷ (freshInput + cachedInput)。
_Avoid_: 缓存率、命中率

**Tokens Processed（处理 token 总量）**：
freshInput + output + cachedInput。
_Avoid_: 总 token

**Unpriced（无价）**：
无法确定价格的请求；计入请求数与 token 数，但不计入成本合计。
_Avoid_: 免费、未知价格

**Allocated Cost（分摊成本）**：
把一次 Run 的 receipt 成本按同模型的计费 token 比例分配到各 Request 上；同一 Run 内分摊之和等于其记账成本。
_Avoid_: 估算成本、实际成本
