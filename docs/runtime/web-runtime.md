# Web 会话运行接入

## 范围与入口

`/sessions/:sessionId` 挂载 `features/sessions/SessionPage.tsx`。世界开局创建成功和会话列表均进入该页。支持线性文本叙事的发送/停止、流式正文、已保存历史分页、查询恢复、三作用域状态、行动建议、世界组件、消息渲染、用量和会话设置。不提供重新生成、失败重试、历史回退、生成中编辑。

本功能只使用 Server 原生契约；用量展示所需的请求快照由 Server 编译、随实际主叙事请求保存并通过 usage 返回。SDK 根入口与 V2 舞台运行时共用同一契约。

## 职责和数据属主

| 位置 | 职责 |
|---|---|
| `features/sessions/workspace.ts` | 会话元信息、装配、真实 tip、首次读取和重连协调、展示投影 |
| `features/narrative` | send/stop、原生 run 事件、当前运行和临时模型输出 |
| `features/history` | 持久 entries 的唯一客户端集合、五轮分页、seq 补查、消息投影 |
| `features/state` | global/session/message 读写与有效值、消息数组归一化、状态事件 |
| `features/suggestions` | 当前建议，创建、清空和最新结果恢复 |
| `features/worlds/stage-world.ts` | 世界详情、组件编译、资源地址、展示规则与状态根清单 |
| `transport/session-events.ts` | 单一会话 SSE、显式事件注册、订阅分发与连接状态 |
| `stage-host` | iframe、origin/source/nonce 握手、MessagePort、命令白名单、外观 |
| `frame.tsx` 与 SDK `stage` | 作者代码与消息渲染、只读展示镜像、命令代理 |

SSE 跟随会话页面，MessagePort 跟随 iframe。重新加载舞台只替换展示连接，不重新发送模型输入、不主动停止运行、不清空业务数据。世界组件或某个订阅者失败不改变已受理运行的业务结果。

## 服务端协议

- 发送：`POST /api/v1/sessions/:id/narrative/runs`，正文 `{input:{text},expectedTipEntryId}`。返回真实 `{runId,userEntryId,assistantEntryId}`，没有客户端请求去重 ID。
- 停止：`POST .../narrative/runs/:runId/stop`；请求取消不等于已收到终态。
- 历史和状态：使用 narrative/runs 的完整轮次、nextCursor、nextAfterSeq、activeRunId，以及三作用域 state 路径。真实 tip 从 session、摘要事件和终态取得，不能以最后可见 assistant 替代 compaction tip。
- 当前事件：run.created/summarizing/summarized/delta/usage/completed/stopped、state.changed、action_suggestions.created。旧 run.phase/run.failed、usage.updated、action_suggestions.changed 均不参与 V2。
- 临时输出按 messageId 归属，delta 追加，snapshot 整体替换。snapshot 不表示已保存；终态先按 savedMessageIds 移除未保存输出，再补查 runs 页，持久 entries 按相同 ID 接管，未保存输出不冒充历史。
- action_suggestions.created 是完整集合，run.created 清空旧建议。恢复只认最新 run 的实际完成结果，不能寻找更早建议填补空结果。建议只读取 output.actionSuggestions 的整体 status/items；history 将 output 透传给 Stage，状态成功/失败诊断来自同一 stateUpdate.updates 列表中的 status。两类结果没有 results；旧格式由服务端读取时归一化，前端不重复兼容。
- 状态 path:"" 替换完整 scope；null 是普通字段值。PATCH success 可以表示路径不存在而被忽略；字段请求值不能直接写入本地缓存。按真实事件/补读同步，混合作用域写入按原顺序分组，无跨 scope 原子承诺。

## 初次读取与连接恢复

先注册事件消费者并建立 SSE，读取会话元信息、历史和状态。重连后逐页补查新 seq，若最新已读轮次仍在运行，从其末条 seq 的前一位置开始补查，覆盖只有终态变化的情况。读取带代次与事件版本，迟到的 HTTP 结果不得反盖新事件；会话元信息读取合并并在历史恢复后重新确认真实 tip。

SSE 无回放。丢失过流连续性时，不把后续缺头的 delta 拼成完整正文；等待最终 snapshot 或保存结果。断线不停止运行，退出页面只释放本地订阅。异常提交不自动重发，查询同步后仍保留未确认的输入草稿。

## Stage SDK

V2 frame 直接注入作者导入的包根入口 `@sillyrealms/sdk`。公共值由 Server 支持的语义组成：

| API | 返回/行为 |
|---|---|
| `useSRSession().send(text)` | 真实 accepted IDs |
| `useSRSession().stop(runId)` | 真实 stopping 回执 |
| `useSRSession().getRuns(query)` | 原生 `RunPage` 的 items/entries 和游标 |
| `useSRStageSnapshot().connected` | 宿主 SSE 的当前连接状态，首次挂载、断线和重连时均以快照为准 |
| `useSRSession().subscribe(listener)` | 原生 SessionEvent 名称和数据 |
| `useSRSession().setDraft(text)` | 受限命令更新平台输入草稿，返回 Promise |
| `useSRStageSnapshot()` | 不可变展示镜像，包含连接、历史、当前 run、建议和状态 |
| `useSRHistory()` | 展示历史及 loadMore/refresh/query 命令 |
| `useSRStateAPI()` / `useSRState()` | 显式读取或显示镜像；写入通过 Host state feature |
| `useSRWorldStateAPI()` | global 状态查询 |
| `SR.WorldStory` | 官方纯展示组件，不独立执行历史合并/恢复 |

Stage SDK 通过 `@sillyrealms/sdk` 导入。frame 的事件订阅不重复驱动业务 reducer；React 所需镜像只由 Host snapshot 替换。Stage 中的文档在已有隔离文档内直接渲染，不创建嵌套 iframe。

## 桥接与展示

官方 WorldStory 直接展示 AI 正文，用户消息使用右对齐的主题强调色淡色气泡。行动建议放在对应 AI 消息正文下方，以轻边框、淡阴影的圆角按钮呈现，点击填入草稿。服务端运行配置的 `debug` 为 true 且该消息有处理结果时，在建议下方显示可展开的「数据处理结果」。

frame 没有业务 HTTP/模型凭据。SDK 发起 narrative.send/stop、history.loadMore/refresh/query、state.read/write、composer.setDraft 等白名单命令；Host 用当前会话绑定决定资源身份。查询返回值、原生事件和展示快照通过 MessagePort 返回。预览文档仍只开放 global 查询。

作者组件执行、messageRender、图片/音频和消息 DOM 均在独立来源 frame；匹配使用有界 Worker，CSP 允许 worker-src self，保持 connect-src/frame-src none。主站和舞台分别构建为 dist 与 dist-preview，部署规则见 [管理工作区](web-management.md)。

运行页复用输入框、主题、字号、阅读锚点和状态查看器。移动会话详情隐藏主导航底栏以避免遮挡输入；保留返回列表。会话业务配置在生成中禁用，阅读字号可独立调整。

## 用量面板与写入约束

会话顶栏复用 V1 的响应式摘要和展开面板：空间足够时显示累计 Token、最近输入/模型窗口/占比，空间不足时整体收起为“用量”。面板展示模型上下文及系统/摘要/历史组成、会话累计、非缓存输入/缓存读取/缓存写入/输出细分和缓存命中率。

数据来自 `narrative/usage` 的已记录合计与 `latestContext`。窗口占比用主叙事实际 inputTokens 除以请求时真实窗口；组成用最终编译文本 UTF-8 字节加 V1 约定消息开销的比例，明确标注不代表逐类实际计费 Token。无快照、旧记录缺窗口/组成、最新请求未知输入均展示未知，不使用上一轮数据补齐。stale 显示旧快照提示，切换 apiModelConfigId 后立即触发用量重读。

输入包含缓存，非缓存输入为 inputTokens-cacheReadTokens-cacheWriteTokens，累计图不会重复计算缓存。存在未知用量请求时提示累计不完整并隐藏缓存命中率。实时 run.usage 包含摘要与主叙事总量，独立展示且不再次加到持久合计，也不充当主叙事上下文输入量。

运行期间服务端阻止当前会话写入（SESSION_WRITE_LOCKED/409）和状态写入（STATE_WRITE_LOCKED/409）；global 在所属世界任意会话运行时禁写。组件经桥发起的 PATCH 同样受保护。读取、SSE 和 stop 仍可用。界面禁用业务设置只是提示，服务端才是写入限制的执行点。

## 已知能力边界

Server 当前不提供旧 capabilities 布尔开关接口；设置不显示其旧启用状态。用量统计范围是已持久化的可信 metrics，未知用量、未保存助手等情况不能视为完整账单。

## 验证

使用普通函数和注入端口验证控制器、事件通道、scope 读写、桥接、SDK 镜像和组合竞态；运行 Web 类型检查 与两个静态产物的生产构建。不启动真实服务、浏览器、模型或 Keychain，函数验证不宣称完成真实端到端或视觉验收。
