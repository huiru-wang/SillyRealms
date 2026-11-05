# SR 脚本、状态 API 与临时变量

> **职责与权威范围**：JavaScript/EJS 执行边界、SR API、局部与 Run 临时变量的权威来源；持久状态语义以状态规范为准。

> 2026-11-05 目标设计，尚未实现。SR 是 SillyRealms 的简称。状态访问、脚本执行、内容激活和文本渲染职责独立；以[状态设计](state.md)为状态定义和持久化权威。

## 脚本与状态读取

SR 以 JavaScript（ECMAScript）作为脚本语言，EJS 作为文本模板；`load.when` 是返回 boolean 的 JavaScript 表达式。应在实现前固定 ECMAScript 引擎版本、EJS 版本和宿主 API，并验证所承诺的语言特性。支持语言特性不等于开放 Node.js、文件、网络、数据库、浏览器 DOM 或进程 API。用户提供的 JS/EJS 须在可终止、限制 CPU/时间/内存/输出并与宿主隔离的执行环境内运行；不得仅依赖 Node `vm` 作为安全边界。运行环境与部署平台的隔离能力、兼容性和资源限制须先做 PoC。

StateReader 使用调用方提供的三个作用域的只读逻辑视图，以 Lodash 路径读取，路径可为字符串或字符串数组。Global 是**单张世界卡级**，不是应用所有世界共用；Session 在同一会话的分支之间共享；Message 沿本分支父链取最近有效状态。三个作用域彼此独立，同名路径不合并。Run 初始读取三个已提交状态并保留只读初始视图供 when，另复制为本轮可更新工作状态；首页无 Session/Message，引用它们报清晰诊断，不虚构数据。

```js
getState('首页.公告', { scope: 'global' })
getState('偏好.显示模式', { scope: 'session' })
getState('清月.灵力', { scope: 'message' })
getState(['清月', '衣服.外套'], { scope: 'message' })
setState('清月.心情', '放松', { scope: 'message' })
```

`getState` 的 `scope` 可省略：按 global → session → message 依次查找完整路径，找到 null 也停止；全部缺失返回 `undefined`。显式 scope 只查指定范围；首页不可用的 Session/Message 不参与默认查找，显式指定则报诊断。`setState` 的 `scope` 必填。可用 `??` 处理缺省。数组下标从 0 起；对象结果是与存储隔离的副本，直接修改引用不会写入状态。拒绝原型污染路径并按作用域对应 Schema 校验。`getState/setState` 是 SR API，后续 API 另行定义；不提供 `getwi/activewi` 或隐式酒馆全局作用域。

## 状态写入与时机

`setState` 在 Prompt 正常脚本阶段按指定 scope 写本轮完整工作状态；每次先校验目标和类型，成功后后续脚本的 `getState` 立即看到结果。它返回工作状态更新结果，不代表已持久化。`when`、延迟构建的 worldState 本体和首页展示只读，禁止 `setState`。预览使用独立工作状态，可以演示后续读取变化，但不持久化。模型自主更新只允许 Message；模型部分变更在脚本变更之后按顺序应用至同一完整工作状态，未涉及字段保留。

Run 完成且校验成功后，Global、Session 和完整 Message 工作状态分别写 `worlds.state`、`sessions.state` 和本轮最终 Assistant 的 `entries.state`；跨作用域在同一 SQLite 事务核对读取版本并原子提交，冲突或失败不提交任何状态、不覆盖旧消息。Run 失败或取消丢弃工作状态。读取的状态视图和已输出的文本不回头重渲染。

## 临时变量

变量均不持久化。每条世界书条目和每条角色描述的 JavaScript `const/let` 为独立局部执行环境；执行结束销毁，也不共享预设或其他条目的局部变量。`setvar(name, value)` 和 `getvar(name)` 使用该次 Run 共用的临时变量表，按确定执行顺序跨条目/角色描述/预设共享，不设置持久化 scope；未设置时 `getvar` 返回空字符串 `""`，已存在的 null、false、0 按原值返回。写入值按可序列化 JSON 深拷贝，读取也返回副本；脚本失败不保留该脚本对临时表的部分写入。Run 完成、失败或取消后销毁；重新生成、重试、并发 Run 各自新建隔离表。预览每次独立创建并销毁，不能影响 Run。

加载判断早于模板渲染，`when` 不可使用 `setvar` 或 `setState`，也不依赖后续正文写入的 Run 变量。已激活模板按 Preset 的节点顺序及各节点 before/body/after 的稳定顺序串行渲染；每个模板执行结束其局部变量销毁，但成功写入的 Run 变量供后续模板使用。未命中条目不会写临时变量；读取不到时返回空字符串，不报错。用户输入和历史正文是 literal，不执行脚本。
