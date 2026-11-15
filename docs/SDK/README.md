# SR SDK 文档

核对日期：2026-11-15。本文档依据当前工作区实现及相关测试，面向使用世界卡的玩家、编写世界卡界面的作者，以及维护 SR 的开发者。SDK 包名为 `@sillyrealms/sdk`，仓库版本为 `0.1.0`，目前是 `private` 工作区包；本文不假定它已发布到 npm。

SR SDK 让世界卡中的 React 组件参与故事体验：展示历史与流式正文、读取和更新状态、把选项填入平台输入框，以及发起一次对话。平台提供模型连接、会话、持久化和输入框；作者主要负责自己的展示与交互。

## 从哪里开始

| 读者或问题 | 文档 |
| --- | --- |
| 玩家：按钮、状态、停止和失败意味着什么 | [用户使用指南](user-guide.md) |
| 作者：创建第一个舞台和详情组件 | [开发者入门](quick-start.md) |
| 如何发送、读历史、订阅生成进度 | [会话 API](session-api.md) |
| 如何读写状态，作用域和部分成功如何处理 | [状态 API](state-api.md) |
| 官方故事界面、消息组件、正文渲染怎么用 | [组件与消息展示](components.md) |
| SDK、Host、Server 如何协作，故障如何排查 | [运行逻辑与排查](runtime-and-troubleshooting.md) |

## 先选对运行环境

| 能力 | 会话舞台、消息组件 | 世界介绍、开局预览组件 |
| --- | --- | --- |
| React 展示与局部交互 | 支持 | 支持 |
| 官方故事列表 | `SR.WorldStory` | 不提供 |
| 草稿、发送、会话历史、Run 事件 | `useSRSession` | 不提供 |
| global / session / message 状态 | `useSRStateAPI`、`useSRState` | 只允许 global 查询 |
| 查询当前世界全局状态 | 会话状态 API | `useSRWorldStateAPI` |
| 状态写入与订阅 | 支持，受 Server 校验及运行锁约束 | 不提供 |
| 消息正则的捕获组 | 正则消息组件获得 props | 不提供 |
| 直接访问 Server、数据库、模型凭据 | 不提供 | 不提供 |

这两种环境都使用 `@sillyrealms/sdk` 名称，但实际提供的运行时能力不同。详情 iframe 中的 `useSRStateAPI` 是只读别名，推荐显式使用 `useSRWorldStateAPI`。会话 iframe 没有安装世界详情的 Provider，不能反向用详情 Hook 代替会话状态 API。

## 公开入口

| 类别 | 导出 |
| --- | --- |
| 故事组件 | `SR.WorldStory`，不是独立的 `WorldStory` 命名导出 |
| 会话与状态 Hook | `useSRSession`、`useSRStateAPI`、`useSRState`、`useSRWorldStateAPI` |
| 静态内容组件 | `RichText`、`WorldDocumentRenderer`、`WorldDocumentContent` |
| 会话类型 | `SRSessionAPI`、`ChatMessage`、`Run`、`RunEvent`、`SessionRunEvent`、`RunPhaseEvent`、`RunPhase`、`RunMetadata`、`HistoryRunsResult` |
| 扩展结果类型 | `RunExtensions`、`StateUpdateResult`、`ActionSuggestionsResult` |
| 状态类型 | `SRStateAPI`、`StateScope`、`StateValue`、`StateEvent`、`SRWorldStateAPI`、`WorldStateQuery` |
| 消息组件类型 | `MessageComponentProps` |
| 样式子路径 | `@sillyrealms/sdk/world-story.css`，由 Studio 会话入口加载 |

上表是包入口导出清单，并不表示每个运行环境都开放全部导出。详情环境仅暴露 `useSRWorldStateAPI`、受限的 `useSRStateAPI`、`WorldDocumentContent`、`RichText`。

`SessionRuntime`、`StateRuntime`、各 Provider、消息 reducer 与底层 transport 是平台集成实现，不属于作者可导入的包入口。没有公开的停止生成 API、原始卡读取 API、模型调用 API 或 `SRSessionEventHub`。

## 与世界卡文档的关系

世界卡负责声明组件、状态初值、开局和展示规则；SDK 负责组件运行时的操作。完整卡格式参考 [世界卡结构规范](../world/world-card.md)，内容组织参考 [世界卡构建指导](../world/world-card-authoring-guide.md)，详情权限参考 [世界卡组件与展示权限](../design/world-components.md)。

当前使用 `data.components[]` 和 `data.stage_component`。不要使用旧的 `ui.source`、`ui.main`、`@sr/sdk` 或 `message_render.component_source`。

本文档描述当前行为，不承诺未来功能。状态错误字段的声明与实际响应差异单列于 [状态 API](state-api.md#当前类型声明与实际返回的差异)，并未因编写文档而修改 SDK 实现。
