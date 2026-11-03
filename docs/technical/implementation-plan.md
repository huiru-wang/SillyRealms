# SillyRealms 领域重构实施规划

> 2026-11-03，**仅设计与架构阶段，未开始实现**。对应 Preset、Provider、AgentContext、WorldInstanceContext、Session/Run 五个领域及状态/存储协作。以 `apps/SillyRealms/docs/design/*` 和 `technical/*` 为当前唯一规范，不把本任务列表当另一份数据协议。

## 0. 先冻结的跨域决策

| 决策 | 已确定 | 验证/延期 |
| --- | --- | --- |
| Preset | 配置资产，有序 `nodes[]`，七系统节点唯一；自定义文本/role/预算和只读 Snapshot，不绑定 Provider | 导入旧格式工具的兼容转换 |
| Provider | 只允许预置供应商、模型、API Key；独立适配 Pi；差异在 Provider 内收敛 | Pi SDK 全量 Messages 注入与流式 Tool Call 必须 PoC |
| AgentContext | 每轮单独构建、状态先加载、before/body/after、纯文本工具、统一主流程预算；输出有序 Messages | 模型严格 Tokenizer 计量需对照真实 Provider |
| WorldInstanceContext | Session 级世界定义预索引、角色宏、Schema 缓存与 Run 压缩拓扑；进入重建，按版本失效 | 增量缓存可晚于正确性全重建 |
| Session | Run 是树/分页/隐藏数单元；Message 在 Run 内；世界线只画 Root/Fork | 旧 Entry 真实数据迁移须另行备份/验证 |
| State | 每 Run 完整强类型 Snapshot，受限 ChangeSet 原子应用 | 叙事-状态语义一致性依真实场景基准 |

## 1. 实施路径和可执行任务

### 阶段 A：协议与独立 PoC（阻塞后续编码）

- [ ] A1. 冻结 `PresetSnapshot`、`ModelMessage`、`WorldInstanceContextView`、`Run/Message`、`StateView`、`StateOutputContract` 的 TypeScript DTO 与只读/版本契约；建立领域模块依赖图，检查没有循环 import。
- [ ] A2. 固定支持的 Pi Agent SDK 版本；验证 AgentContext 的**完整有序 Messages[]** 能否通过公共 API 原样进入模型（特别是后置 system/custom role、历史分叉重建），记录实际请求和差异。失败不得假装已支持。
- [ ] A3. 验证至少两个预置 Provider 的 API Key、模型目录、真实流式/取消、Tool Call、长文本与 strict Schema 兼容；明确哪些型号可以开启 submit_turn，不能开启的使用内联状态模式。
- [ ] A4. 通过 100+ 剧情样例验证强类型状态/ChangeSet 召回、复杂 Record 更新、Token 与成功率；基于结果冻结输出通道默认策略与预算门槛。

### 阶段 B：基础持久化/基础配置

- [ ] B1. 建立 `presets` 表与 `PresetService`：七节点不变量、配置校验、CRUD/复制、expectedRevision、导入导出、默认预设恢复。
- [ ] B2. 建立版本化内置 Provider 声明、每 Provider 独立 Adapter、模型能力过滤、CredentialStore 和用户 Key 检测界面；禁止用户自定义 Endpoint。
- [ ] B3. 调整 SQLite `sessions/runs/messages` 逻辑结构、唯一 Run 父链、User+Assistant Message ordinal、`run_tree_revision`、状态 Run 快照/幂等/状态修订；准备数据库迁移与回退。
- [ ] B4. 依新格式同步 `examples/default-preset.json`、世界卡示例和数据校验测试；导入旧世界卡/状态数据时只做可检查的 dry-run，不静默覆盖。

### 阶段 C：世界实例缓存与构建流水线

- [ ] C1. 实现 `WorldInstanceContextService.open/refreshIfStale/invalidate`：角色宏、WorldBook/状态 Module 预索引、版本戳与进入时确定性重建。
- [ ] C2. 实现纯 `StateLoader`：冻结父 Run 快照、状态根激活优先于其它 Prompt、条件和动态写入目标生成；不在 WorldInstanceContext 缓存动态状态。
- [ ] C3. 构建系统节点注册表和独立的 7 个 NodeBuilder + CustomTextBuilder；HookResolver 统一处理 before/body/after、世界书 mode/关键词/when/禁用和排序。
- [ ] C4. 实现独立纯文本处理：`{{user}}`、状态引用、if/else 条件和受控声明式转换；无任意 JS 副作用，错误定位与单次展开。
- [ ] C5. 实现 AgentContext 主流程 TokenBudget：先保留必需状态/协议/输入，再按预设节点顺序裁剪；历史最小保留单位是**完整 Run**；输出 Messages 和构建诊断/Preview，与 Provider 无依赖。

### 阶段 D：Run 产品与整体执行

- [ ] D1. 完成 Session 的 Opening Root Run、用户 Run 提交、同 Run Assistant 补全、状态失败处理、重试幂等、分叉/活动叶子冲突校验。
- [ ] D2. 实现 `GET /sessions/:id/runs` Run 级分页/游标、Run/Message UI 分组、跨世界线分页清理和同线追加时的视觉锚点保留。
- [ ] D3. 实现 Root/Fork-only 压缩图；边保存 `branch_start_run_id`、`collapsed_run_count`、`terminal_leaf_run_id`，无 Leaf/BranchStart 图节点；用 Run 元数据全重建作为基线。
- [ ] D4. 给 WorldInstanceContext 增加可丢弃缓存及明确失效：世界卡同步、WorldBook 手动选择、角色快照、状态迁移、Run 新增、历史 Message 编辑；缓存正确性与全重建对拍。
- [ ] D5. 打通 AgentService → AgentContext Messages → Provider/Pi → StateEngine → Run/Message 单事务闭环，确保失败/取消无半成品 AI Message；状态文本与工具消息不进入可见历史。

### 阶段 E：验收、迁移与回滚

- [ ] E1. 模块级测试：Presets round-trip/重复七节点拒绝、Provider key 脱敏、StateLoader 先于 NodeBuilder、before/body/after 顺序、系统节点 role 继承、通用模板安全性。
- [ ] E2. 端到端：1000+ Runs 祖先分页/缓存构图、嵌套分叉 2/3→3/3、隐藏 Run 数量、旧历史编辑 stale、服务重启恢复、相同 Run 重试与 Provider 异常。
- [ ] E3. 对旧格式（Entry 树、world/user 状态、旧 Preset 中的模型连接）制定可逆迁移/备份与 dry-run；无真实旧数据时以生成测试集模拟，绝不未经用户确认批量改写真实记录。
- [ ] E4. 提供模块服务 API 契约/错误码文档，验证端到端需求完成后才把各领域标题从“尚未实现”改为已实现；未经实测不得标注 Pi 多消息注入和复杂 Tool Call 成功。

## 2. 验收必须先冻结的指标

- **一致性**：任意 Run 的完整快照和其父链正确，分支绝不串线；失败 ChangeSet 不部分执行；重复 generation ID 不重复扣值。
- **预设体验**：导入/导出、角色/节点排序与内容 round-trip 完全一致，系统七节点恰好一次，Preset 与 Provider 没有耦合。
- **AgentContext**：同输入得同 Messages 与诊断；系统 NodeBuilder 无预算逻辑，任何钩子在统一文本处理后才参与主流程预算，历史不拆 Run。
- **世界线**：压缩图只有 Root/Fork；每条边的 Run 折叠数量等于父链实际隐藏节点数，终止边可进入真实叶子。
- **Provider**：内置列表可控、API Key 不泄露、真实模型接入后消息顺序正确、流式取消与错误恢复可复现；复杂工具模式必须用真实模型测试。
- **缓存**：进入重建与版本失效后 WIC 索引和拓扑精确等价，缓存全部删除后不会影响恢复。

## 3. 风险、回滚和范围

高风险依次为：Pi 是否支持按原 role/order 注入完整 Messages；Tool Call 是否支持超长叙事且能稳定流式；Run/Message 替换旧 Entry 树的历史数据迁移；压缩图增量缓存的准确性；复杂 WorldBook 触发/模板安全。

在 PoC 通过前不启动大规模核心代码重构。实现顺序是 DTO/PoC → 持久化/配置 → 纯构建器 → 会话 UI/集成 → 大量测试。数据库变更前一致性备份；升级失败可以回滚 schema/migrations 并恢复完整备份，不用缓存回写纠正真实数据。根本无数据迁移时旧方案仅留在 Git 历史，不维护运行时双协议。当前只改文档与例子，没有创建数据库/部署 Provider/改写真实世界实例。

## 4. 文档同步范围

- `docs/design/preset.md`、`provider.md`、`agent-context.md`、`world-instance-context.md`、`session.md`；
- `docs/design/world-card.md`、`state.md`；`docs/technical/storage.md`、`architecture.md`；
- `docs/PRODUCT.md`、`README.md`、`docs/examples/default-preset.json`；
- 后续真实编码时按上述权威文档同步具体模块接口；设计本轮不写实现代码。
