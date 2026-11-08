# G3 验收裁决 — NIM 网关模型 limit/options + 任务级 effort override

- 分支 / worktree：`model-limits`（隔离实例 `master`，端口 3102，embedded PG 54330）
- 日期：2026-11-08
- 方法：ui-acceptance（判据前置，真实 UI 路径 + API/DB 双源取证）
- 受测模型（验收中途切换）：`meta/llama-3.1-8b-instruct` → `z-ai/glm-5.3-flash`（前者 NIM 已 EOL，见缺陷 D2）

## 判据表

| # | 判据 | 结果 | 关键证据 |
|---|------|------|----------|
| C1 | Connection 模型可配置 limit.context=262144、limit.output=65536、options.reasoningEffort=max，保存后 API/UI 回读一致 | **PASS** | `c1-*.png`×3；GET ai-connections 回读 `{"id":"z-ai/glm-5.3-flash","limit":{"context":262144,"output":65536},"options":{"reasoningEffort":"max"}}` |
| C2 | 编辑器校验（重复 Model ID 等）拦截保存 | **PASS** | `c2-duplicate-id.png`；保存按钮禁用 + 行内 alert |
| C3 | 模型详情只在点击入口后的次级视图出现，不常驻任务聊天流 | **PASS** | `c3-*.png`×4；初始视图无 `262,144` 文本，点 "Model details" 后出现 |
| C4 | 任务级临时 effort override：UI 入口 → 下次 run 生效，且不改写 Connection 默认 | **PASS（后端，D1b 修复后）/ FAIL（UI 入口，D1a 遗留）** | 见下 |
| C5 | 旧形态连接（无 limit/options）编辑器字段为空、可保存、原行为不变 | **PASS** | `c5-legacy-editor-empty.png`、`c5-legacy-save.png`；保存后 models 回读 `[{id,label}]` 无新增字段；代码级：`openCodeModelConfig` 对缺失字段返回 `{}`（既有单测覆盖） |
| C6 | 真实 NIM run：Connection 默认路径全链路（durable input 无 override → 上游请求成功） | **PASS（默认与 override 路径均真实 run 通过；UI 入口缺口同 D1a）** | 见下 |

## C4 / C6 override 路径 — FAIL 详情（缺陷 D1）

**D1a（产品缺陷，UI 入口缺失）** composer 对 `paperclip_runner`+opencode agent 不渲染 effort 滑块：
`composerEfforts()` 对 opencode harness 恒返回 `[]`（`ui/src/components/task-chat/composer-run-settings.ts` L69-96，既有单测断言的预存行为，本分支未改）；任务属性侧的 thinking-effort 下拉仅覆盖 `opencode_local` 直连类型，不含 runner+opencode。后端 override 写路径存在（PATCH `assigneeAdapterOverrides.adapterConfig.modelReasoningEffort` 200，Properties 显示 "Override · adapter options"），但普通用户没有 UI 入口能走到它。

**D1b（功能缺陷，运行时冲突，本分支引入）— 已修复并复验通过**：
- 复现：ACC-1（override=high）comment 触发 run `fd22e1cf-922c-4dd1-9310-d7c104e29d86` → **failed**，错误 `turn.reasoningMode requires a durable custom-gateway effort`（两次重试同错；run log + `c4-override-run-failed.png`）。
- durable input 本身正确：`nativeExecutionInput.provider = {kind:"opencode", model:"paperclip/z-ai/glm-5.3-flash", permissionMode:"allow", reasoningEffort:"high"}`（heartbeat_runs.runner_profile_json）。
- 根因（证据链闭合）：durable effort 被**双重投影**——
  1. 本分支把 `packages/paperclip-runner/src/backends/codex-native-backend.ts` L161 的 driver 级投影从 `input.provider.kind === "codex" && …` 改为无条件，于是 opencode 的 durable effort 也进入 driver/session（`codex-harness-session.ts` L252-254 在 turn/start params 里带 `reasoningMode:"high"`）；
  2. 同时 `server/src/services/native-runtime/native-session-executor.ts` L14342-14344 把同一 effort 传给 transport options（`opencodeReasoningEffort:"high"`）；
  3. `runnerd-codex-transport.ts` L6453-6456 判定「per-turn reasoningMode 与 durable effort 同时存在」为冲突并 throw。
- **修复（用户批准后实施）**：恢复 L161 的 codex-only 条件（durable opencode effort 只走 transport 通道，其 turn 构造点 L6496 已有 per-turn 应用）；回归测试 `native-backend-factory.test.ts` "keeps the durable OpenCode effort on the transport channel instead of the Codex driver session"（已验证对 buggy 写法 fail、对修复 pass）。
- **复验（ui-acceptance 正式复验，run 期真实 NIM，两条真实路径 run）**：
  | run | override | 结果 | durable input（DB） | 上游请求（usage_request_logs） | UI 证据 |
  |---|---|---|---|---|---|
  | `91f4c817`（17:57） | high | **succeeded**（34s） | `reasoningEffort:"high"` | `557732f4…` http 200, tokens 35830/178 | 线程回复 "pong"，任务 Done，`c4-override-run-succeeded-after-fix.png` |
  | `ad8c81cc`（18:25） | **low**（复验前经 API 改值） | **succeeded**（29s） | `reasoningEffort:"low"` —— 值按任务动态流动，非缓存 | `b74ce9b3…` http 200, tokens 36083/3 | 线程回复 "pong"，状态 done，`c4-override-low-run-succeeded.png` |

  两次 run 2/2 成功；Connection 默认两次回读不变（仍 max / 262144 / 65536）。相关测试面全绿：runner 包 backend/transport/opencode 驱动 711 passed、server native-runtime 153 passed。回归测试对 buggy 写法 fail、对修复 pass（已双向验证）。
- 不变式验证 ✓：override 未改写 Connection——修复前后 GET ai-connections 回读均为 `options.reasoningEffort:"max"`。

## C6 默认路径 — PASS 详情

- 任务 ACC-2（无 override，调度开启后经 UI 新建）→ run `46440e9a-883e-420d-a66c-6cc5119cb7e9` **succeeded**（native/opencode_server，22s），agent 回复 "pong"，任务 Done（`c6-default-run-succeeded.png`）。
- durable input：`provider = {kind:"opencode", model:"paperclip/z-ai/glm-5.3-flash", permissionMode:"allow"}` — 无 `reasoningEffort`，Connection 默认只经 `PAPERCLIP_OPENCODE_MODEL_CONFIG` 进沙箱配置，符合设计。
- 上游证据（`usage_request_logs`）：`provider=paperclip, model=paperclip/z-ai/glm-5.3-flash, input_tokens=33291, output_tokens=156, http_status=200, provider_request_id=7d0f84ef-6406-4638-8896-70d4d53da797, occurred_at=16:48:55`（run 存活区间内）。
- 沙箱 `opencode.json`（limit+options 投影的直接物证）为 run 期临时文件，run 结束即删，本次未在存活窗口内捕获——记为观察项 O3，可后续以 run 期轮询取证。

## 缺陷与观察项清单

| ID | 级别 | 描述 |
|----|------|------|
| D1a | 产品缺陷 | runner+opencode agent 的任务级 effort override 无 UI 入口（composer 滑块恒缺、任务属性下拉不含该 harness 形态）；后端 API 链路已修复并验证，入口待产品跟进 |
| D1b | ~~功能缺陷（阻断）~~ **已修复** | durable effort 双重投影致 opencode run 必然失败；已恢复 codex-only 投影 + 回归测试，复验 run succeeded（见上） |
| D2 | 环境缺陷 | NIM `meta/llama-3.1-8b-instruct` 2026-08-26 EOL（410 Gone），验收换用 `z-ai/glm-5.3-flash`；hello probe 与 agent/连接均已更新 |
| D3 | 预存缺口 | agent 级 "Thinking effort" 下拉对 runner+opencode 显示 claude 选项组（Auto/Low/Medium/High，无 max），与本分支无关 |
| O1 | 观察项 | 连接模型保存成功提示被 refetch 立即清除（"Model settings saved." 几乎不可见） |
| O2 | 观察项 | provider trace 帧全 redacted（stdio 通道 + operator_only），对上游请求取证无用；上游证据需走 `usage_request_logs` |
| O3 | 观察项 | 沙箱 `opencode.json` run 期临时存活，未捕获；如需直接物证可在 run 期轮询 `isolated-workspaces/**/homes/home-*/config/opencode/opencode.json` |
| O4 | 观察项 | 新建连接页首次加载出现一次 "Paperclip couldn't start" 错误边界，刷新后恢复；未复现第二次，归因未定 |

## 附：验收环境与数据

- company `1e963393-91bd-4a8b-9eee-74ccb5cebba3`（ACC 前缀）
- 连接：`c809f852…`（chat/bearer，integrate.api.nvidia.com，模型 z-ai/glm-5.3-flash / 262144 / 65536 / max）；C5 另建 `bf675d8f…`（ACC Legacy Gateway，无 limit/options）
- agent `1393aaab…`（acceptance-agent，paperclip_runner+opencode，setup 完成，holds=[]）
- 任务：ACC-1（override=high，run failed）、ACC-2（默认，run succeeded）
- 调度：实例 Settings→Experimental "Run tasks in this worktree" 已开启（armed，cutoff 2026-11-08T08:48:16Z）
- NIM 凭据：`~/.paperclip/nim-acceptance.env`（chmod 600；未打印、未写入本报告）

## 建议：可自动化检查

- 回归测试已落（runner 包）；可再加：`native-session-executor` 层「opencode durable effort 只进 transport options、不进 driver options」的投影断言（防止 server 侧再次双投影）。
- runner-e2e（`tests/runner-e2e/`）可加一条 gateway effort journey：从环境变量读网关凭据，跑一次带 override 的最小任务并断言 run succeeded（本地验收已人工完成两次，CI 化留作跟进）。

## 结论（2026-11-08 更新，D1b 修复 + ui-acceptance 复验后）

**修复 D1b 后验收通过（含 ui-acceptance 正式复验 2/2 真实 run），可进入提交流程（提交/合并/部署仍需用户确认）。**
C1/C2/C3/C5 通过；C6 默认与 override 两条路径均以真实 NIM run 验证通过（usage 双源）；C4 的后端语义修复后通过，UI 入口缺失（D1a）作为已知产品缺口记录、不阻断本分支（override 仍可经任务属性/ API 设置）。D1b 修复内容：`codex-native-backend.ts` 恢复 codex-only effort 投影（1 行）+ 回归测试（1 个）。业务改动仍未提交、未推送、未部署。
