# SR 预设字符串模板与单层编排（config schemaVersion 3）

## 目标与范围

按 2026-11-16 确认的预设优化需求执行。本方案替代 v8 运行时方案中关于 prompt.parts、自定义节点固定插入区域、会话内容预览及 session.background 的约定。其他运行时生命周期、压缩、状态更新和后置处理契约保持现有行为。

- config_json 只有一层有序 nodes；每个节点含 id/name/kind/role/enabled/prompt，prompt 为完整字符串。
- schemaVersion 从 2 升为 3；SQLite 数据库仍为 v6、预设仍使用原八列。
- 自定义节点可插在完整列表任意位置，包括 main 前和末尾。数组顺序同时用于存储、编辑和正式编译。
- 内置相对顺序：main、personaInfo、characterInfo、worldInfo、chatHistory、userInput、worldState（如有）、actionSuggestions（如有）。六个 system 节点必需且启用；两个 postprocess 节点保留独立开关。固定 ID、kind、role 仍受校验。
- 保存/导入时乱序报错，不自动重排；保存冲突继续采用 If-Match ETag，失败保留草稿。

## 模板与 Context

模板支持显式命名变量：user、persona.prompt、characters.prompts、world.lore、history.summary、history.messages、input.text、state.currentValues、state.updateRules。

- 使用 {{name}}；允许名称周围空白。未知名称和未闭合变量在保存时报告字段路径与原因。
- 两个连续反斜线表示一个字面反斜线；反斜线紧接双左大括号表示字面双左大括号；其他反斜线保持原样。
- 仅扫描预设模板一次，不再扫描替换结果。世界卡原有精确 {{user}} 宏继续在 Context 材料构建阶段处理。
- 普通文本变量可以跨节点、重复或不引用；普通 prompt 可为空。
- history.messages 仅允许在 chatHistory/auto 中出现一次；input.text 仅允许在 userInput/user 中出现一次，允许添加前后包裹文字。
- auto 将连续文本形成 system 消息，遇到消息变量先结束文本消息，再原角色展开历史。摘要与本轮输入不会混入历史消息列表。
- Context 继续先冻结来源，在候选/最终保留历史上选择材料。变量读取不查询数据库，不增加模型调用；压缩后的最终激活不受旧候选影响。
- 无激活可写状态时继续省略整个 worldState 节点；后置处理权限和提示使用同一 roots 集合。

默认 chatHistory：

```json
{"id":"chatHistory","name":"会话历史","kind":"system","role":"auto","enabled":true,"prompt":"<已有摘要>\n{{history.summary}}\n</已有摘要>\n{{history.messages}}"}
```

## 组成统计

在实际编译、发送内容时同步归类 UTF-8 字节：模板文字与普通材料归系统，history.summary 归摘要，input.text 和原生历史归历史。重复引用按实际次数累计，未引用和未发送的内容不计入。每条消息保留固定 16 字节的结构估算；模板消息结构归系统，原生历史结构归历史。该组成用于显示，不等同于 Provider 真实计费或完整输入 Token 估算。正式预算仍使用最终 messages 的既有固定估算器。

## 编辑与默认恢复

Studio 以 nodes[] 作为唯一有序草稿，不再分别重建 style/customNodes/raw 中的节点。自定义条目支持全列表拖拽、键盘移动和节点前后插入；内置节点保持相对顺序。所有节点使用统一 prompt 编辑弹窗，系统变量提供简洁参考与插入。

恢复默认复用 GET /api/v1/presets/default，根据节点 ID 只替换弹窗草稿中的 prompt，再经应用和保存生效。默认来源为版本资源，不是可编辑的数据库默认预设。运行时不回退到默认资源。

## 删除边界

- 删除 PromptPreview 组件、会话选择/预览输入/结果展示，以及 POST /api/v1/presets/preview 和其专用逻辑、测试。
- 保留正式 Run 的共享 compileContext、候选预算编译和 Provider 请求指纹预检查。
- 删除 session.background 变量、会话状态描述拼装及默认背景包裹；保留 summary/messages、session 状态存储和加载条件判断。

## 显式格式转换

运行时及导入接口只接受新格式。离线工具 migrate:presets 默认 dry-run，仅 --apply 执行写入：

```sh
pnpm --filter @sillyrealms/server migrate:presets --file /absolute/preset.json --output /absolute/preset-v3.json --apply
pnpm --filter @sillyrealms/server migrate:presets --database /absolute/sillyrealms.sqlite --dry-run
pnpm --filter @sillyrealms/server migrate:presets --database /absolute/sillyrealms.sqlite --apply
```

文件转换保留备份；数据库转换持有原数据目录锁、先验证全部记录、用 VACUUM INTO 备份，再通过事务和原值比较只更新 config_json/updated_at。保留预设 ID、模型参数、引用、会话、历史和状态。无法识别的自定义背景包裹显式报错，禁止猜测删除。旧文字中的字面变量与反斜线进行转义，保留原 {{user}} 宏语义。

当前默认导入示例为 sr-default-preset-v3.import.json；旧 v8 附件作为历史记录保留。

## 验收

- 默认变量、字面转义、不递归、原生历史角色、当前输入原文及压缩后激活正确。
- 首部、内置节点之间、尾部自定义条目保存/导入导出后顺序相同；内置乱序和非法变量被拒绝。
- 每个系统节点可编辑，单节点恢复默认只改该 prompt；失败与 ETag 冲突保留草稿。
- 确认无会话背景注入、会话预览界面或接口；session 状态依然可参与加载判断。
- 转换 dry-run、备份、锁冲突、幂等、全记录校验和事务回滚使用隔离数据测试。
- 运行 typecheck/lint/test/build，针对预设执行桌面与移动端浏览器交互及截图检查。
