# WorldStory 消息 MDX 渲染执行任务 v1

> 日期：2026-11-15。状态：待实施，全部任务尚未完成。
> 方案：[WorldStory 消息 MDX 渲染方案](./sr-worldstory-message-mdx-v1.md)。
> 本文件仅拆解工作；写入计划不授权执行产品代码修改、迁移、提交或推送。
> 单 agent 顺序实施、独立复核，不派生子 agent。

## 执行顺序

```mermaid
flowchart LR
    T1[技术可行性与基准] --> T2[兼容用例与契约冻结]
    T2 --> T3[规则转换与安全 AST]
    T3 --> T4[MDX 与组件绑定]
    T4 --> T5[流式调度与缓存]
    T5 --> T6[WorldStory 集成]
    T6 --> T7[完整回归与独立审查]
    T7 --> T8[切换与旧实现清理]
```

T1 未通过不得进入正式迁移。T7 未通过不得删除 Portal 正常路径。每个任务记录实际变更文件、命令与结果，不能用本文中的验收目标代替测试证据。

## T1 — 验证 MDX 技术路线与状态保持（最高优先级）

- [ ] 核对执行时工作区与本方案基线，保留其他未提交修改。
- [ ] 在测试入口验证 format=md 下平台注入 MDX 节点、兼容 HTML 清洗、function-body 编译与组件注入的完整顺序；检查 MDX 实际生成代码。
- [ ] 验证固定 MessageMdx 调用无 Hook 生成函数：组件计数器点击后，连续追加正文不会卸载；禁止用新的编译函数作为 React 根类型。
- [ ] 覆盖 inline/block、单子节点变多子节点、强调闭合、列表、表格、引用链接，记录普通追加与结构性重解释的区别。
- [ ] 用真实隔离 iframe / 生产构建验证 React 单例、CSP，不通过临时放宽策略让实验通过。
- [ ] 对 2K/20K/100K 字符、1 MiB 边界、500 匹配、20 条历史测准备耗时/长任务/内存/包体；与现有实现对照。

文件边界：SDK 测试与最小编译试验、Studio 浏览器测试入口；仅在执行获授权后用 pnpm 安装验证必需的依赖，不切换生产 MessageContent。

完成标准：记录固定浏览器/设备、版本和结果，确认方案第 5 节目标可达。失败则具体说明兼容、身份或性能阻碍，更新方案后再推进；尤其不能把 async compile 当作 Worker。若需要 Worker 编译，先补充 CSP/清洗环境/生命周期设计。

## T2 — 冻结兼容契约与可执行样例

依赖：T1。

- [ ] 整理现有 message-matching、message-ranges、message-portal、world-story-roleplay、world-document 测试，形成可执行兼容矩阵。
- [ ] 固定规则优先级、原始 UTF-16 偏移、三种 replacement、block/inline、opening 跳过规则语义。
- [ ] 固定旧 MessageComponentProps，不增加 props 模板、自动 namedGroups 展开或公共 API。
- [ ] 加入两个同名组件不同参数、emoji、未闭合标记、花括号/引号/换行、原始 HTML/GFM 的样例。

文件边界：`packages/sr-sdk/test/`、`apps/server/test/message-*.test.ts`、必要的测试 fixtures。

完成标准：当前实现的有效行为能由用例描述；目标差异列入方案并有明确处理，不能以“MDX 默认行为”跳过兼容。

## T3 — 实现规则转换、bindings 与安全 AST

依赖：T2。

- [ ] 新增 message-mdx/prepare.ts，输入快照与匹配结果，输出可编译树、bindings、诊断。
- [ ] 保持原文偏移校验、保护区与重叠规则；markdown/html 替换不递归触发组件规则。
- [ ] 只允许平台节点调用 SRMessageComponent；绑定参数留在数据表，绑定来源与当前消息一致。
- [ ] 复用/适配 HTML、URL、CSS 与内部标记清洗；保留 data-sr-markdown、角色扮演与 opening 语义。
- [ ] 加入伪造绑定、JS/ESM/事件/spread、危险 URL/CSS、原型属性等负例。

文件边界：`packages/sr-sdk/src/message-mdx/prepare.ts`，按需提取 `world-document/render.ts` 内清洗 helper；相关转换/安全测试。

完成标准：源文本和替换结果均不能生成未经授权的可执行 AST；捕获值原样作为数据到达组件；静态文档清洗回归通过。

## T4 — 实现 MDX 编译与稳定组件绑定

依赖：T3。

- [ ] 实现 compile.ts 固定编译配置与产物验证，不接受世界卡提供编译插件。
- [ ] 实现固定 MessageMdx / MessageComponent 与消息级 bindings Context。
- [ ] 复用 StoryConfiguration.components 和 iframe 模块缓存；保留 match/groups/namedGroups/message/runId。
- [ ] 使用稳定 key 与固定根结构，添加局部/消息级 ErrorBoundary 和当前安全正文回退；禁止直接调用作者组件。
- [ ] 验证缺失/报错组件仅影响自身，JSX 名称无效的组件 ID 仍能通过内部绑定使用。

文件边界：`packages/sr-sdk/src/message-mdx/`，必要的 `apps/studio/src/frame.tsx` 引用稳定处理，SDK 浏览器用例。

完成标准：正文与组件同树渲染、捕获参数正确、旧组件不改源码可用；错误不污染 Run 或其他消息。MDX 依赖只随会话渲染所需入口加载，不重复打包 React。

## T5 — 实现流式调度、缓存和结果时序

依赖：T4。

- [ ] 最新快照合并、每消息执行/等待队列有界、revision 与规则/组件版本核验；render/bindings/诊断按同一 revision 原子应用。
- [ ] 新编译尚未完成时保留旧有效视图，失败改为当前安全正文；禁止直接拼接旧视图与原文后缀。
- [ ] terminal 快照优先排入并最终应用，旧任务不能覆盖结束状态正文。
- [ ] 保持普通尾部追加时计数器、焦点和组件身份；测试结构性父节点变化的约定行为。
- [ ] 终态历史缓存、分页不重复编译、切换/卸载清理；匹配超时与编译错误分别处理。

文件边界：MessageContent / MessageMdx / compile.ts 的消息级调度，浏览器竞态与性能测试。默认不修改 SSE/reducer/Host 匹配协议。

完成标准：延迟/乱序/停止/切会话/历史恢复均收敛到当前权威文本；缓存有界，T1 性能目标在正式实现中仍达标。

## T6 — 接入 WorldStory 与兼容回退

依赖：T5。

- [ ] MessageContent 接入新路径，StoryRun 的 message.id 外壳和 RunFeedback 独立结构保留。
- [ ] user/assistant 规则按 roles 处理；opening 不匹配，指令面板和正文转义不丢失。
- [ ] 保持作者舞台主动使用 WorldStory、readonly 预览权限、Host 输入与滚动行为。
- [ ] 更新浏览器 runner：将 message-portal 的产品语义迁入 message-mdx，并实际执行。
- [ ] 测试期以内部选择做新旧对照，不新增用户设置或世界卡开关。

文件边界：`packages/sr-sdk/src/message-content.tsx`、必要的 world-story.tsx 参数、SDK 测试、`apps/studio/test/world-document/run.mjs`。

完成标准：默认及自定义舞台内 WorldStory 都可用；不存在整条消息重复渲染、原文替换入库或未执行测试入口。

## T7 — 完整回归与独立审查

依赖：T6。

- [ ] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:browser`，逐项记录结果和覆盖范围。
- [ ] 375px/1280px 检查实际截图、焦点、历史滚动、流式卡片、局部错误与正文回退。
- [ ] 在生产 iframe 验证 sandbox/CSP/React 单例、Host 请求权限、卡内模块依赖与组件异常。
- [ ] 同一 agent 做独立审查：从原文到 AST 到执行的来源边界、JS 注入、编译函数身份、异步覆盖、卸载与内存。
- [ ] 对发现问题给出源文件证据并修复，按影响重新验证；记录包体和性能最终数据。

完成标准：方案第 9 节的兼容、安全、流式矩阵通过，无关键缺陷或未解释失败。缺少本机浏览器等环境阻碍必须明确报告，不视为通过。不得调用付费模型或用户数据库验证。

## T8 — 正式切换与旧实现清理

依赖：T7 全部通过。

- [ ] 让 MDX 成为正常消息渲染路径；移除临时对照选择，保留安全正文回退。
- [ ] 搜索消费者后删除不再使用的消息 Portal / message-dom 实现；其他 UI 的 Portal 不在范围内。
- [ ] 移除旧插槽身份实现断言，保留并增强相同组件状态/焦点/流式行为断言。
- [ ] 按核心渲染重构要求更新相关产品/设计说明与 AGENTS.md，将实现约束从 Portal 改为稳定组件身份；不新增 docs/technical 文档。
- [ ] 对清理和文档契约变化运行相关回归，确认静态 WorldDocumentRenderer 仍可用。

完成标准：只有一套正常组件渲染路径；无数据迁移，无原始消息修改，公共 props/规则结构保持兼容。交付清单注明测试、性能数据、结构性重解释限制与代码回退方式。提交/推送仍需要用户另行明确授权。

## 本次规划交付检查

- 两个文件职责分开：方案定义效果、边界与架构，本文定义顺序、文件范围和验收。
- 所有实现任务保持未勾选，不宣称架构验证或浏览器测试已经完成。
- 本次仅校验计划的链接、示例 JSON/正则、任务引用、Markdown 结构与差异；不安装依赖、不修改产品代码。
