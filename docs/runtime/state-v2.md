# 状态 v2

世界卡的 `data.state.schema_version` 必须为 `2`。不接受 v1 定义、旧状态数据或旧预设变量。定义和规则保存在世界卡；消息快照仅保存根名及当前值。

## 定义与可选规则

每根状态必须声明 `type`、`initial` 和非空 `description`。类型为 string / number / boolean / json。只有 number 根支持有限 min / max。json 根允许任何安全 JSON 值。

规则路径包含根名，不包含 scope。对象用句点，数组元素用 `[]`，嵌套数组支持 `[][]`。根名及对象字段不得为空，不得包含 `.`、`[`、`]`，不得使用 `__proto__`、`prototype`、`constructor`。允许中文。

`rules` 可以省略或为 `{}`。世界卡导入或编辑状态定义时，若提供规则，须为合法路径到非空白字符串的映射；规则不必覆盖根、子字段或数组元素，也可以预声明未来字段。例如 `人设` 只写 `{"人设.姓名":"使用自报姓名"}`，不会妨碍未写说明的“门派”读取或更新。开局和写入不依据规则校验状态值；规则文字不会执行为程序。

构建 Prompt 时不再校验规则条数、路径或文字格式。仅为本轮已加载的 message 根输出作者提供的说明，无条目时省略整个 rules 段。没有规则不影响该根的加载或写权限。

## 运行时状态

全局、会话、消息三个 scope 分别对应世界、会话和消息条目。开局的 `initial_state` 按 message 根覆盖，创建会话时随开场消息保存。后续消息可以继承前驱状态。

服务端 `POST /api/v1/state/query` 读取单个目标的有效字段。省略 paths 返回所有根，指定 paths 返回有序字段行。`POST /api/v1/state/update` 逐项更新已有路径，有效变化在提交后通过会话 SSE 发布。见 [HTTP 状态接口](server-http.md#状态接口) 和 [会话事件](server-events.md#状态事件)。

预设和自定义 prompt 可引用三个整组变量 `{{state.global}}`、`{{state.session}}`、`{{state.message}}`。每组只包含本轮满足 load 条件的已声明根，读取当前快照。global 和 session 作为只读背景，状态更新节点开启时才授权模型更新本轮激活的 message 根。该节点的 {{state.update.message}} 展开根名及可选的作者规则。正文、模型状态更新结果、行动建议以及调试展示的持久化和发布规则见 [叙事执行](server-narrative.md) 与 [舞台接入](web-runtime.md)。
