# SR 固定系统节点与预设提示词 v5 实施任务

日期：2026-11-15。状态：待实施；方案见 [完整方案和提示词](./sr-fixed-system-preset-v5.md)。本轮只新增这两个方案文件，不修改业务代码、正式 docs、AGENTS 或数据库。

全部任务由当前单 agent 顺序负责。以下列出文件边界、依赖和完成条件；尚未执行，不把方案清单视为实施授权。

| 任务 | 依赖 | 文件边界与工作 | 完成条件 |
| --- | --- | --- | --- |
| T1 核定契约与基线 | 无 | 检查 git status、AGENTS、现有 v1–v4 方案、当前源码/测试；梳理每种请求文案和预设消费者 | 八节点、Direct 固定能力、Agent/摘要/诊断隔离、迁移语义形成可审阅的字段契约；已知冲突显式列明 |
| T2 默认预设数据 | T1 | 新增 `apps/server/resources/presets/default.json`；整合本文主节点、摘要、Agent、工具描述与诊断提示 | 完整、版本化、无占位文案；2/3/4 建议示例渲染后合法；工具描述无遗漏；种子可由运行时相同 schema 校验 |
| T3 预设 schema 与 CRUD | T2 | `apps/server/src/routes/presets.ts`，必要的 domain 预设 schema 模块，`runtime/types.ts`；检查 catalog/create/import/export/PATCH 消费者 | 新 schemaVersion；固定八节点、角色/顺序/来源；拒绝非法关闭/缺失；revision 冲突；导入、复制、导出不丢用途配置 |
| T4 无损迁移 | T3 | `infrastructure/database/database.ts`、独立预设转换模块和临时 DB 测试 | 完整备份、事务、幂等、旧原文/引用/能力保留；已改默认不覆盖；缺失新字段不走懒 fallback；失败不部分迁移 |
| T5 纯材料装配与模板编译 | T3–T4 | `runtime/context/prompt-builder.ts`、`direct-prompt.ts`、`system-main.ts`、`context-manager.ts` | SR 文案只从冻结预设读；sourceMap；世界材料 load 与模板隔离；受限 getConfig；输入/历史原角色；state.current 只序列化数据 |
| T6 全用途接入 | T5 | `runtime/config.ts`、`context/compaction/summary-generator.ts`、`tools/state-tool.ts`、`model/pi-gateway.ts`、Agent continuation 及模型测试调用方 | Direct 无平台强开逻辑且来源为 preset；摘要/Agent/诊断没有隐藏文案；工具结构校验不被预设改写；Direct 无 tools |
| T7 预览与消费者契约 | T5–T6 | 现有 session/context 路由、预设只读候选预览入口、`apps/studio/src/api.ts`、`SessionSettingsDialog.tsx` 与相关能力 API | 模板/候选/冻结/wire 清楚区分；无付费调用与 DB 写入；旧 false 覆盖不悄然生效；creator iframe 无新增权限；未支持预览明确报错 |
| T8 Studio 八节点查看 | T7 | `features/presets/types.ts`、`adapter.ts`、`PresetStore.tsx`、`PresetLibraryPage.tsx`、`PromptEditorDialog.tsx`、必要 CSS | 展示服务端八节点，去掉平台伪节点；每节点全文可读；既有 main/摘要编辑保留；固定节点无关闭/删除/拖动；空/错/加载/取消及焦点完备 |
| T9 回归与独立复核 | T2–T8 | Server 相关测试、Studio browser suite；单 agent 另起一次完整阅读审查 | 捕获实际 mock Provider 请求，来源覆盖；状态失败矩阵/压缩/冻结/迁移验证；375/1280 截图与交互通过；发现的问题修复后定向复验 |
| T10 文档与交付 | T9 | 更新相关预设产品文档、设计说明和根/子目录 AGENTS；标记旧方案被替代 | 仅描述已实现行为；移除已过时的平台提示/七节点说法；报告所有检查、未覆盖范围、迁移与兼容限制；不自行提交或推送 |

T10 的文档与 AGENTS 更新基于用户关于核心链路/模块重构的要求，在代码实施阶段完成；本轮方案阶段不改写事实文档。

## 具体测试清单

- `presets.test.ts`、`studio-preset.test.ts`：八节点身份和顺序；非法 false/when/删除；main 名称；新建/保存/复制/导入/导出；修改文字、空必填、revision 冲突；原有自定义节点 round-trip。
- `direct-prompt.test.ts`、`context.test.ts`、`roleplay-context.test.ts`：不再期待额外 platform systemMain；真实 payload 全文/角色/顺序；默认例子输出 2/3/4；无状态/只读/同名 scope；配置值含标签或模板字符；输入 verbatim；世界卡 load=never。
- `narrative-extensions.test.ts`、`session-runtime.test.ts`：信封损坏、缺少必需状态、无变化 []、逐项跳过与重复路径、建议单独失败、partial 阻止建议、取消/stop、reason 省略，保持现有 authoritative commit 语义。
- `budget-v2.test.ts`、`compaction-lifecycle.test.ts`：完整提示参与预算；只压缩历史；一次完整摘要；最终历史激活；编辑与 await 交错；接受输入及失败结算不变。
- `runtime-config-api.test.ts`、模型测试/目录相关测试：Direct 来源 preset、合法 count/preferences 保留、非法新关闭拒绝；Agent 覆盖不变；diagnostic 指令和工具描述有来源，独立预设缺失报错，测试输出不接入真实状态。
- 新的预设迁移测试：临时旧版本 DB、已修改官方预设、postHistory、自定义角色和顺序、旧状态文本、会话 false 覆盖、标签/引用、未知旧数据备份、幂等、事务失败与恢复；不操作真实 DB。
- Studio 浏览器测试：逐一查看八节点；原文/展开区别；未选会话、无材料、请求失败重试；main 编辑后保存、保存失败草稿；键盘关闭与焦点返回；375px、1280px 无截断和横向溢出；无 console error。

## 检查命令与覆盖边界

实施前再次检查 package scripts；当前根目录命令：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:browser
```

- typecheck 覆盖 Server 和 Studio。
- lint 当前只运行 Server ESLint，不能称为全仓 lint。
- test 当前运行 Server Vitest；需要明确其实际涵盖的跨包/契约测试。
- build 当前构建 Studio，不能称为所有包独立 build。
- test:browser 使用现有隔离 API/storage 与离线 Provider；先核对实际脚本覆盖预设流程，再补本任务必要断言。

定向用例先运行；整体检查一次完成，只有修复或新疑点才扩大/重复测试。全部只用临时存储和 mock Provider，不执行 reset:data、真实付费模型调用、提交、推送或发布。

## 方案阶段复核

- 已核对运行时代码中的基础、Direct 扩展、摘要、Agent 工具与诊断文案，以及默认数据库种子和 Studio 查看入口。
- 已明确 v4 与本次“不可关闭”的冲突，区分节点启用、数据加载、状态 required 和建议空数组。
- 已区分完整默认模板的新措辞与旧预设保真物化，避免以“迁移”覆盖用户自定义。
- 已保留用户输入原文、历史原角色、最终激活权限、严格扩展失败矩阵，以及单 agent/本地优先/iframe 权限边界。
- 已对文档示例做离线 JSON/数量/长度校验，覆盖 2/3/4 条建议，并检查方案间链接；未据此声称运行时协议或模型验证通过。
- 本轮不运行 typecheck/lint/test/build/browser；新方案尚未实现，这些命令不构成方案内容正确性的证明。
