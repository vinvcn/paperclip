# Usage 采集点在 provider 代理，不在 runner 事件

P1 的逐请求日志由本地 provider 代理记录：`paperclip`/`openrouter` 路由的每次 HTTP 调用都经过 `startOpenCodeProviderProxy`，代理能看到模型、tokens、状态码、首 token 与耗时，且不需要改动任何 harness。代价是只覆盖走代理的流量（本实例 opencode 流量 100% 走 paperclip 路由）；直连内置 provider 的流量与 legacy adapters 留到 P2 用 runner 事件补齐。

## 考虑过的选项

- **runner 新增逐请求事件**：覆盖更全，但要解析 opencode 的 SSE usage，改动面大，P1 不划算。
- **后处理沙箱 opencode DB**：延迟、且只覆盖 opencode。
- **两者组合**：作为 P2 的演进方向保留。

## 后果

- 采集失败或代理绕过时，该请求只出现在 `cost_events`（turn 级）里，Usage 页看不到——这是 P1 已知边界。
- 后续接入新 harness 时，需要同时决定它是否走代理，或补 runner 事件。
