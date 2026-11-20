# Server 上下文独立实施任务

状态：已完成（实现与验证）。设计见 [server-context-design.md](server-context-design.md)。

## 1. 独立入口和快照

- [x] 建立 context/index.ts 唯一 prepareContext 入口及显式公开类型。
- [x] 内部捕获在用户保存后首次异步等待前完成，不把领域快照留给外层重组。
- [x] 返回最终请求、激活根、后续 parent、已提交摘要回执及准备失败。
- [x] 外层 narrative 仅等待准备结果、调用主模型并继续原保存/终态流程。

## 2. 阶段迁移和摘要闭环

- [x] history、materials、assemble、template、estimate、budget 迁入 context，删除旧位置实现。
- [x] compact 拥有 plan、summary-request、saved-summary，通过 summarize 端口执行，不写库/发 SSE。
- [x] 每个候选重新激活材料、组装实际消息并估算；最终使用最终 activeRoots。
- [x] 成功摘要草稿在后验预算或编译失败时仍返回，context 编排器保存并返回实际回执。
- [x] 中立模型收集从 narrative 分离，输出 splitter 和公开事件仍由 narrative 处理。
- [x] 保留每轮一次摘要、五轮保护、父链、取消、未知用量和失败保留语义。

## 3. 条目级旁注

- [x] 通用旁注按 entryId 独立关联，可支持 user 来源，原正文保持不变。
- [x] 叙事先选择最近两条可见 assistant，没有 output 不回找更早条目。
- [x] 状态只读取 updates 中 status=success 行的 path/value/reason，建议读取有效 items，行状态与诊断不注入模型；各来源独立失败，保留 partial_success 有效内容，旧格式兼容由 SessionService 读取投影完成。
- [x] 最终保留消息才渲染旁注，预算包含，摘要/关键词排除，重复候选不重复拼接。
- [x] 明确历史记录与未执行建议的区别，保留标签转义，编辑正文不宣称已重算。

## 4. 机械边界与文档

- [x] 新增 contextEntry：外部（含测试及类型）只可导入 context/index.ts。
- [x] 新增 contextDependency：context 生产代码不能依赖其他 usecase 或 EventHub/SSE。
- [x] 架构函数测试 8/8 通过，测试文件定向 ESLint 通过。
- [x] 同步 narrative/events/http 运行事实文档、两级 AGENTS 和旧输出方案。
- [x] 最终复核未引入新表、HTTP、前端适配或输出侧历史重建。

## 5. 最终验证与交付

- [x] 完整函数测试通过：39 个测试文件、465 项测试；命令见设计方案验证记录。
- [x] Server typecheck、lint 均 exit 0，git diff --check 通过。
- [x] 独立评审摘要副作用、notes 预算/投影与单入口边界。
- [x] 方案状态更新为已完成（实现与验证），运行文档与实际接口一致。

验证使用内存/临时库、模型流和凭据替身，不启动服务或真实模型。

## Git 交付

按本轮授权提交推送全部代码和文档，并核对远端提交与工作区状态；结果以 Git 历史及本轮交付记录为准。
