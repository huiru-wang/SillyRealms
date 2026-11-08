# WorldStory 运行时 v1

平台会话页负责标题、预设设置、连接提示和默认展开的输入区；输入区可收起。用户 Enter 发送，Shift+Enter 换行；运行时可停止生成。输入草稿属于平台页面，作者组件的 `session.setDraft` 通过 MessageChannel 替换草稿，不会自动发送。`session.send` 与平台输入使用同一 Host 发送流程；202 表示服务端接受，不表示生成成功。

无自定义页面时，隔离 iframe 加载系统 `SR.WorldStory`；有 `ui.source` 时加载作者页面，作者可在其中组合 `SR.WorldStory`。Host 按会话缓存世界卡的静态配置、页面和消息组件编译产物，并将规则、状态声明传入 iframe；Host 不缓存状态值或消息历史。状态 Hook 使用 iframe SDK 本地快照，显式读取仍通过 Host 向 Server 请求。

系统界面通过 Run 历史及事件显示消息，状态面板按 global、session、message 展示；宽屏默认展开，窄屏默认收起。首次历史读取时缓冲的、属于已包含 Run 的增量可能暂时缺失，收到终态后使用完整消息更新。断线事件不重放，不能保证断开期间的流式消息继续合并；连接恢复后 SDK 重新读取状态。

WorldStory 在展示时合并同一 Run 中相邻的 assistant 叙事，段落之间插入空行；历史和流式事件采用相同规则。原始消息和工具调用仍按各自记录保存。状态提示要求模型完成叙事后再检查并调用更新工具，这仅是模型指令，不保证调用时机或状态与全文一致。

作者组合自己的状态栏时可使用 `<SR.WorldStory showState={false} />` 隐藏系统状态按钮和面板；省略该属性时仍显示系统状态面板。世界介绍与角色介绍都可在无脚本隔离 iframe 中展示完整 HTML 和 Markdown。

消息组件模块编译失败、缺失或局部渲染失败时，相关匹配回退原文；作者自定义页面整体编译、求值或根组件运行失败时，平台显示“世界卡数据异常”并阻止继续会话，不切换系统界面。已发往 Server 的请求不能承诺撤销。Worker 执行正则设有单规则与总时间预算，处理失败会展示原文或保留已完成的匹配；它不运行作者组件。

iframe 保留 opaque-origin sandbox、CSP、受限 import 和 MessageChannel 边界。`connect-src 'none'` 不代表完全无网络：当前 CSP 仍允许 HTTPS 图片和媒体。DOMPurify 负责 HTML 清理，不负责 CSS 白名单；系统对内联 style 另行筛选。事件处理器的异步异常和组件死循环不保证被 React 错误边界捕获。

世界详情的世界介绍、角色介绍、开局和世界书正文使用 SDK 的 `WorldDocumentRenderer` 静态文档表面。世界详情通过角色列表选择可扮演角色，在开局页切换开局并创建会话；运行配置页设置此世界的新会话默认预设与模型。初始状态检查器展示 message scope 的默认值与当前开局覆盖合并后的全部状态，不写入状态。JSON 覆盖替换整个状态项，global/session 状态不受开局覆盖。静态预览不运行会话的消息展示规则或作者组件，创建会话后的首条消息仍经过正常消息渲染流程。

静态文档在无脚本 iframe 中呈现；会话消息继续留在既有会话 iframe 中，通过共享解析和净化管线生成行内内容，以保留组件插槽和流式更新。静态与会话的 sandbox 和权限边界各自保持独立。完整 HTML 文档与 Markdown/HTML 混排均可作为字符串输入；可用 `data-sr-markdown="true"` 显式标识需要解析 Markdown 的 HTML 容器。作者 HTML、CSS 与资源受净化和 iframe CSP 的限制，不支持脚本和表单；源码及持久化消息不会因展示而改写。
