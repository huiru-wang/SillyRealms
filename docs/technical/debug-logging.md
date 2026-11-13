# Server Debug 日志

2026-11-14 已实现。用户明确要求按 Run 查看完整模型 messages 与原始输出；这是对此前禁止输出提示词规则的限定例外，仅在显式启用 debug 时生效。

从仓库根目录启动：

```sh
SILLYREALMS_DEBUG=1 pnpm dev
```

不设置该变量或设为其他值时，不打印 debug 内容。启动信息和既有状态校验 warning 仍可输出。日志只写终端，不创建日志文件；没有新增依赖或业务表。

每条记录只调用一次 console，参数为单个字符串。结构为 UTC ISO 时间、层级标记、记录类型、关联字段、` | ` 和紧凑 JSON。类型与关联字段之间仅一个空格，不做固定宽度补齐。正文中的换行、控制字符被转义，长行可能在终端视觉折行，但不会产生额外日志记录。关联字段使用完整 ID，不截断，支持并发 Run 交错打印后按 runId 筛选。

```text
2026-11-14T00:00:00.000Z ╔═ RUN BEGIN sessionId="s" runId="r" requestId="user-request" | {"sessionId":"s","runId":"r","requestId":"user-request"}
2026-11-14T00:00:00.010Z │  CONTEXT LOAD sessionId="s" runId="r" | {"category":"角色","mode":"always","active":true}
2026-11-14T00:00:00.020Z ├▶ MODEL BEGIN sessionId="s" runId="r" requestId="model-request" requestIndex=1 phase="generation" | {"provider":"example","model":"example-model"}
2026-11-14T00:00:00.021Z │  MODEL INPUT sessionId="s" runId="r" requestIndex=1 | {"source":"pi-context","messages":[{"role":"user","content":"你好\n继续故事"}]}
2026-11-14T00:00:00.022Z │  MODEL REQUEST sessionId="s" runId="r" requestIndex=1 | {"source":"provider-payload","payload":{"messages":[{"role":"user","content":"你好\n继续故事"}]}}
2026-11-14T00:00:00.200Z │  MODEL OUTPUT sessionId="s" runId="r" requestIndex=1 | {"source":"pi-response","status":"completed","response":{"content":[{"type":"text","text":"原始故事及扩展尾块"}]}}
2026-11-14T00:00:00.201Z └■ MODEL END sessionId="s" runId="r" requestIndex=1 | {"status":"completed","durationMs":181,"usageReported":true}
2026-11-14T00:00:00.210Z ╚═ RUN END sessionId="s" runId="r" | {"status":"completed","durationMs":210}
```

示例省略部分关联字段与内容，实际输出不裁剪 messages 或正文。

| 类型 | 内容 |
|---|---|
| HTTP | 每次接口响应一行：method/path/query/status/durationMs；不输出 HTTP 请求正文、Cookie 或鉴权头。SSE 接口的耗时是响应建立耗时，不是连接存活时长 |
| EVENT | 除 message.delta 外，每个 Runtime 事件一行；记录事件名、阶段/状态、消息 ID 等元数据。message.delta 正常发送，但不打印日志 |
| RUN BEGIN / END | 已接受 Run 的开始和结束；结束包含持久终态、错误码、耗时；终态无法读取时标明 unpersisted，不伪造成功 |
| MODEL BEGIN | Provider 和模型；requestIndex 为同一 Run 从 1 开始的调用序号 |
| MODEL INPUT | Pi Context：完整 messages、独立 systemPrompt、工具定义、输出额度等，用于查看适配前输入 |
| MODEL REQUEST | Pi onPayload 中通过指纹检查后的 Provider 请求 JSON，messages 位于 payload.messages；其他协议可能使用 contents 等字段。不是离线 preview，也不代表网络已成功送达 |
| MODEL OUTPUT | SDK 返回的完整 AssistantMessage，包含未进行叙事清理的正文、thinking、工具调用及 sr_extensions 尾块。它是完整模型内容，不是逐字节 HTTP 响应或所有 SSE 网络帧 |
| MODEL END | completed/error/aborted、错误码、耗时、首段文本耗时及已知用量；没有真实用量时 usageReported=false |

摘要、主生成和工具续轮共用 ModelClient，分别标记 summary/generation/continuation，序号连续。准备失败仍有 Run 边界，但没有实际模型调用时不伪造模型记录。取消、Provider 异常或流提前结束时，打印已收到的部分输出（source=partial）。独立 Provider 探测不属于 Run，其请求日志不伪造 Run ID。

Run 上下文使用 AsyncLocalStorage 隔离；HTTP 或其他会话日志可能插入 Run 边界之间，不能将相邻行误认为同一 Run。日志序列化和终端写入失败不会改变生成结果。

API key、Authorization、Cookie、password、token、凭据引用等字段脱敏；模型请求/输出中回显的当前 API key 及其 URL 编码形式也替换为 `[REDACTED]`。debug 开启后其余完整故事、提示词、状态文本可能出现在终端；它们是本次授权的诊断内容，普通 HTTP/事件日志不额外输出这些内容。
