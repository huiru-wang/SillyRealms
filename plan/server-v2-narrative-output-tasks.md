# ServerV2 叙事后处理实施任务

状态：已完成（实现与验证）。2026-11-20 按最后确认的“各能力只校验自己的标签，标签损坏整体失败、不恢复数据”规则完成下列实施与验收。

设计：[server-v2-narrative-output-design.md](server-v2-narrative-output-design.md)。

## 1. 结果契约与保存保护

- [x] sessions 定义各能力自己的整体/逐项状态，公开 NarrativeOutput、StateUpdateOutput、ActionSuggestionsOutput。
- [x] 删除 blockIndex、line、contextEligible；results 保留输入顺序与可解析的 path。
- [x] appendNarrativeAssistant 受控保存 output；公共 append/edit 禁止伪造/删除，其他扩展编辑保留 output。
- [x] 缺失/空标签使用 no_updates/no_suggestions；模型中断不执行能力，部分助手不生成 output。

验收：旧 entry 可读、结果与正文/state/metrics 同条保存、编辑不重做或回滚，无新增表/版本。

## 2. 独立标签提取与流式隐藏

- [x] 统一正则辅助函数按指定能力名匹配自身起止标签，大小写不敏感。
- [x] 区分完全缺失与自身标签不完整；损坏时 invalid_tag，不从该能力中恢复数据。
- [x] 不扫描其他能力来确定边界或截断，其他能力独立提取。
- [x] 流式隐藏保留跨分片前缀缓冲；最终快照重新分离，公开/保存正文一致。

验收：状态标签损坏不影响完整建议标签，反向同样成立；模型输出块不进入公开正文；不存在跨能力恢复逻辑。

## 3. JSONL 状态候选

- [x] 每行独立 JSON 解析、对象/路径/值/rules 校验和结果规范化。
- [x] StateService 纯候选计算，仅 message scope、本轮激活根、已存在路径；公共 PATCH 语义不变。
- [x] 单行失败恢复该行前副本，成功行按序保留，重复路径顺序覆盖。
- [x] 返回成功更新、逐行结果、完整候选与变化信息，保留其他根和附加元数据。

验收：invalid_json/invalid_update/invalid_path/invalid_value/processing_error 可定位；成功行不回滚，同值成功不发变化事件。

## 4. 建议、提示词与异常边界

- [x] 建议保留数组；单条空白记 empty_suggestion，其他无效项记 invalid_suggestion，保留有效条目。
- [x] 三条为提示词目标，服务端不因过滤后不足三条拒绝整组；每条长度及去重规则保留。
- [x] PresetService 提供默认补足，忽略旧 enabled，不改已有预设 revision。
- [x] compile 加入默认能力与最终固定协议，明确覆盖旧数组/强制标签/固定条数指令，并明确状态更新不设固定条数上限。
- [x] 每个能力独立兜底；状态内部逐行隔离，规范化失败不得清空可靠的成功项。

验收：各能力独立 status；正常正文在能力失败时仍 completed；不增加模型修复、重试或辅助调用。

## 5. 收尾事务与事件

- [x] 在同步事务中校验 tip、生成候选及预计算变更，原子保存助手正文/output/state/metrics。
- [x] 用户及成功摘要不回滚；用户终态仍独立保存；模型未正常完成不执行能力。
- [x] 提交后按序发 state.changed 和 action_suggestions.created，创建事件只承载有效非空建议。
- [x] run.created 驱动清空旧建议；每条通知异常独立处理，继续总 usage 和唯一终态。

验收：回滚或保存失败不产生未提交通知；partial_success 的有效状态/建议正常通知；锁覆盖收尾且终态前释放。

## 6. 上下文与计量

- [x] 输出侧保持干净正文，不承担历史回填或重复执行状态更新。
- [x] 条目级 model-only notes 由独立[上下文方案](server-v2-context-design.md)实施，状态更新和建议仅提供已保存的结果来源；输出处理不依赖其内部阶段。
- [x] 按模型实际输出处理与返回 usage 记录；不增加能力 token、条数或全尾部配额。
- [x] 既有输入预算/压缩与 max_output_tokens 继续复用，实际新增提示词纳入原请求估算。
- [x] 编译拒绝后处理提示词引用 input.text、history.messages、history.summary，避免重复注入；回归用例覆盖摘要单次注入。

验收：无输出侧历史重建、无重复状态执行，隐藏输出用量不被扣减；模型旁注的输入行为由上下文任务独立验收。

## 7. 验证与文档

- [x] 输出后处理交付时运行 `pnpm --filter @sillyrealms/server-v2 exec vitest run src/modules src/usecases src/infrastructure src/http src/testing`，37 个测试文件、434 项测试全部通过；后续上下文迁移的新增验证见其独立任务清单。
- [x] typecheck、lint 均通过，exit 0。
- [x] 函数验证使用流替身与内存/临时库；未启动真实服务、HTTP/浏览器链路或真实模型/Keychain。
- [x] 已同步 server-v2-narrative/events/http 与根/serverV2 AGENTS，清理过期禁止扩展、预留建议、旧事件名、二态和坏标签恢复要求。
- [x] 已复核两份计划和事实文档一致，原 Server/Studio 与 StudioV2 运行适配未混入。

## Git 交付

本轮已授权提交并推送所有修改。实现、验证及文档同步已完成；交付需创建提交、推送远端并核对远端提交与工作区状态，结果以 Git 历史及本轮交付记录为准。
