# Usage 请求日志用独立表，不复用 cost_events

Costs 页的 `cost_events` 是财务账本（逐 receipt×model、幂等、对账语义、可重算）；Usage 页需要逐请求明细（含耗时/首 token/状态码），两者粒度与生命周期不同。决定新开 `usage_request_logs` 表，`cost_events` 保持不动，两表通过 request/run 关联而不互相改写。

## 考虑过的选项

- **扩 `cost_events` 加字段**：少一张表，但把请求日志和财务账本耦合，保留期、清理、重算都会互相牵连，且财务表对账逻辑不能容错日志写入失败。
- **只做视图不落表**：省存储，但无法承载耗时/首 token 等成本账本没有的字段。

## 后果

- 两表需要约定关联键（provider request id / run id），P1 不做历史回填。
- 日志可以独立设置保留期（默认 90 天）与清理任务，不影响账本。
