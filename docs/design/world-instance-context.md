# WorldInstanceContext：每轮加载的世界运行资料

> 2026-11-03 精简设计，尚未实现。`WorldInstanceContext` **不是独立业务 Domain、常驻世界实例、缓存服务或 Agent**，只是一次请求从 Session 及相关领域读取后形成的普通 metadata 对象。名字保留是为了和只构建消息的 `AgentContext` 区分。

## 1. 一句话定义

`Session` 已经持久化世界卡快照、Opening、玩家角色快照、Preset ID、模型选择、世界线活动叶子和状态 Schema。一次用户输入只需按 `sessionId` 读取这些事实，并选择当前 Run 分支的完整有效状态；这份组合即 `WorldInstanceContext`。

- 不另存世界状态、不在 Session 外持久化 Context。
- 不建立 `WorldInstanceContextService.open/refreshIfStale/invalidate`。
- 不拥有 WorldBook 预索引、Schema 编译缓存、Run 压缩拓扑缓存或 revision 失效矩阵。
- 不计算最终 Prompt，不负责 SSE、Provider 调用、状态写入。
- 每轮现取现用；执行完成直接释放对象。真正出现性能瓶颈时再针对数据库查询/纯解析结果做局部优化。

## 2. 最小数据形状

~~~ts
type WorldInstanceContext = {
  sessionId: string;
  session: Session;
  world: WorldCardSnapshot;              // session.world_snapshot_json
  preset: PresetSnapshot;                // 按 session.preset_id 读取、冻结本轮
  userCharacter: CharacterSnapshot;     // session.user_character_snapshot_json
  modelSelection: ModelSelection;        // Session 选择或应用默认
  parentRun: Run;                        // 指定实际父 Run（分叉场景非全局最新）
  parentState: EffectiveStateSnapshot;   // parentRun 的完整有效状态
  stateUpdateMode: "off" | "inline" | "tool"; // 本轮配置的意图，能否 tool 需能力校验
  loreOptions: SessionLoreOptions;       // 本局手动启停选择
};
~~~

这只是示意类型，不强制复制 `session` 已含的字段。如果实现时直接读 `metadata.session.xxx` 更简洁，就不要再制造另一份 DTO。`WorldInstanceContext` 不保存当前用户消息和最终生成历史；本轮输入由 `runAgent` 传入 `buildAgentContext`。

## 3. 加载函数

~~~ts
async function loadWorldInstanceContext(
  sessionId: string,
  parentRunId: string
): Promise<WorldInstanceContext> {
  const session = await sessionService.getSession(sessionId);
  const [preset, parentRun] = await Promise.all([
    presetService.getPresetSnapshot(session.presetId),
    sessionService.getRun(sessionId, parentRunId),
  ]);
  sessionService.assertCompletedParent(parentRun);
  const modelSelection = session.modelSelection
    ?? await providerService.getDefaultModelSelection();

  return {
    sessionId, session,
    world: session.worldSnapshot,
    preset,
    userCharacter: session.userCharacterSnapshot,
    modelSelection,
    parentRun,
    parentState: parentRun.stateSnapshot,
    stateUpdateMode: session.stateUpdateMode ?? "off",
    loreOptions: session.loreOptions,
  };
}
~~~

示例省略请求鉴权、分叉许可和配置字段的物理存储细节；在创建 Run 前须先由 Session 验证用户、目标叶子、父状态有效与并发条件。**必须显式传入已选择的 parentRunId**，不得靠全局最大 seq 推断，历史分叉只能继承它真正的父 Run 状态。

创建 Session 时就校验可用 Preset、角色、Opening、模型/凭据，并保存世界卡快照；**进入实例不会重新执行 Opening 或初始化状态**。修改源世界卡不会自动覆盖本局快照，只有显式同步会更新 Session。修改 Preset/模型只影响之后开始的新 Run；当前执行持有本轮已读取值。

## 4. 正确边界

- **世界线压缩图与分页**：Session Domain 从 Runs 真实父链计算；不属于 Context。
- **世界书匹配和模板**：AgentContext 用本轮输入、祖先历史、已冻结父状态计算；不在加载 metadata 阶段缓存「命中结果」。
- **状态 Schema/工具**：State Domain 负责选择本轮可见根、生成工具约束、校验 ChangeSet；动态值严格从父 Run 全快照取得。单轮状态根选择应只计算一次，供 Prompt 和 Tool 共用，避免两条路径出现不一致。
- **并发保护**：由 Session 的事务、requestId/generationId、父 Run 修订和必要的世界/Schema 修订校验保证；revision 不是构建复杂 Context 缓存的理由。
- **Pi 执行态**：仅存在于本轮 AgentRuntime，不是第二套 Session 真相。

相关：[AgentContext](agent-context.md)、[Session](session.md)、[Provider](provider.md)、[State](state.md)。
