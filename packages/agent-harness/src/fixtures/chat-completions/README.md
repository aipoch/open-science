# Chat Completions 真实响应样本

2026-11-13 从 OpenCode Go 采集并脱敏：`repeated-stop.sse`、`repeated-tool-calls.sse`
来自 hy4-preview，`empty-choices.sse` 来自 GLM-5.3-Flash 对照。

保留完整事件顺序、字段、空值、用量与 `[DONE]`，仅替换响应/工具标识并重新序列化 JSON；
不含凭据、请求头或原始网络分块。回归验证按响应结构处理，与请求使用的模型名无关。
工具样本请求本地无副作用工具 `protocol_probe`，完整参数为 `{"value":"OK"}`。
