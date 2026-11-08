# WorldStory 消息展示格式 v1

世界卡的 `data.message_render` 可选，包含有序的 `rules` 和可选的单一 `component_source`。完整的合成示例位于 [`worldstory-card.json`](../../apps/server/test/fixtures/worldstory-card.json)，可通过世界卡导入接口导入；其中包含开局状态、两个按钮、行内组件和用户消息美化。

规则的 `roles` 为非空的 `user`/`assistant` 数组；`pattern` 是不带分隔符的 JavaScript 正则源字符串；可选 `flags` 允许 `gimsu` 且不重复，默认 `g`。JSON 中正则反斜杠需转义。`replacement` 为 `{type:'markdown'|'html',content:string}` 或 `{type:'component',component:string}`。静态替换支持 JavaScript 的 `$&`、`$$`、编号及命名捕获组替换。规则 ID 唯一，先前有效规则优先；规则不修改会话原文或模型上下文。

消息组件共用 `component_source`，默认导出名称到 React 组件的对象。组件可通过 `@sr/sdk` 的 `useSRSession`、`useSRStateAPI` 与 `useSRState` 操作会话；组件静态属性 `srDisplay` 可选 `inline` 或 `block`，缺省 `block`。`MessageComponentProps` 含完整匹配 `match`、编号捕获 `groups`、命名捕获 `namedGroups`、消息 ID/角色和 `runId`；捕获值为字符串或 undefined。组件负责解析和校验数据。

配置缺失时使用普通 Markdown/HTML 展示。组件模块不存在或引用错误时匹配文本按原文展示。默认不替换代码块、行内代码、链接目标或部分 HTML 标签/属性；完整自闭合占位标签可匹配。无法安全插入的范围会保留原文，禁止消息中的脚本、事件属性及 MDX 表达式执行。HTML 的内联样式仅支持常用白名单属性，资源加载、变量引用及危险样式值会被移除；远程图片/媒体仍受 iframe CSP 限制。正则在 Host 管理的隔离 Worker 中执行，超时规则被跳过并提示；不支持执行原始酒馆脚本。

开局 `initial_state` 在会话创建时作用于 message scope；JSON 状态项按整个值替换。按钮如需与默认开局不同的状态，可先 `batchUpdateState`，根据逐项结果决定是否 `send`；已成功的项不会因其他项失败自动回滚。
