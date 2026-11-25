# 行动建议组件方案 V4：纯数据 Hook、最小历史恢复与接受回执

状态：**V4 已实施，函数与静态验证通过。** 2026-11-25 根据用户确认执行最小恢复方案：刷新恢复复用现有会话历史加载，统一初始化接口移出本次范围。已完成 SDK、Host、官方布局、作者文档与小饭馆／雾港发行包适配；实施结果见第 13 节。

实现基线：`3b9b74e419a9acce333339e1dcfcd21af38e5646`；开始前已 fetch 确认与 origin/main 一致，工作区仅含此前确认的 V4 计划修订。文中的 Hook 和组件已实现；本次未新增服务端 HTTP 接口。

## 1. 确认的五项原则

1. 新一轮确认开始后先清空，收到建议再整体替换；本轮没有建议就保持为空。
2. 建议的更新、去重、执行时序、初始化和刷新恢复全部由 Host 处理，再通过快照注入舞台。
3. 进入会话、整页刷新及重连时，Host 复用现有会话历史加载，读取本会话真正最新消息的行动建议，恢复当前展示状态。
4. 本地提交以 HTTP 同步创建成功（accepted 回执）为主要依据：宿主同批显示已接受的用户消息，并立即清空上一轮建议；SSE 负责确认、补偿及新建议。
5. Hook 只提供 items。官方 Stage 在 items 非空时才挂载整个行动组件，边框、背景、padding、占位容器都不得在空数据时残留。

纠正 V2 的两处扩大解释：

- **组件与历史解耦，不等于宿主禁止从历史恢复。** 恢复能力保留在 Host；组件仍不查历史、不绑定消息。
- **行动建议数据不包含会话操作资格。** 移除 canSetDraft/canSend，不把发送、输入框占用等通用能力塞进建议 Hook。

没有需要再次确认的产品歧义。以下把实现必须遵守的时机、恢复边界和现有同步流程收敛为具体规则。

## 2. 组件与 Hook 契约

~~~ts
export type ActionSuggestionsState = Readonly<{
  items: readonly string[];
}>;

export function useSRActionSuggestions(): ActionSuggestionsState;
~~~

- items 初始为 []，保持只读；不混用 null/undefined/空对象。
- 不暴露 runId、messageId、owner、setter、clear、pending、错误或操作资格。
- 官方组件和作者组件使用同一 Hook，从 Host 注入的最新状态读取数据。
- 不在 Hook 内请求历史、订阅另一条 SSE、扫描正文或做正则匹配。
- 组件挂载/卸载不能清空 Host 状态；多个消费者共享同一份数据。
- 继续复用现有 StageRuntime、StageProvider 和 external-store 订阅，不新增业务 Store/Provider。
- 跨 iframe 传输可序列化快照；React 函数/setter 不通过 MessagePort 传递。

保留 `StageSnapshot.suggestions` 字段名，其展示类型为上述仅含 items 的状态。服务端事件原有身份字段和 Host 内部过滤状态继续保留；它们不属于作者 Hook。

现有能力依据：[Stage Context](../packages/sr-sdk/src/stage/context.tsx)、[Stage Runtime](../packages/sr-sdk/src/stage/runtime.ts)、[展示契约](../packages/sr-sdk/src/stage-contract.ts)。

## 3. 官方 Stage 决定是否挂载完整组件

~~~tsx
function DefaultStage() {
  const {items} = useSRActionSuggestions();

  return (
    <div className="sr-default-stage">
      <div className="sr-default-stage-story">
        <SR.WorldStory />
      </div>

      {items.length > 0 && (
        <div className="sr-default-stage-actions">
          <SR.ActionSuggestions />
        </div>
      )}
    </div>
  );
}
~~~

关键在于：**整个行动区 wrapper 都在条件内部。** 不能始终挂一个带边框、背景或 padding 的卡片，只让里面的按钮数组为空。空数据时也不能通过固定第二行、最小高度或残留 gap 留下占位。

SR.ActionSuggestions 内部同样使用 Hook，负责行动项的默认视觉与点击。它可以对空数组再做防御性 null 返回，但不能用这个替代上层的整体条件挂载。

布局：

- WorldStory 与行动区是兄弟组件，官方默认放在正文阅读区下方、宿主输入框上方。
- WorldStory 只负责正文、分页与阅读；不再定位或显示建议。
- 默认外壳采用可伸缩的纵向布局，正文区域 min-height:0，占剩余高度。
- 当前 WorldStory height:100% 且内部滚动，不能简单在其后追加内容而不调整外壳。
- 行动区多项/长文案时限高并可滚动；常规按容器高度 30% 且不超过 240px，极小高度时允许容纳一行标准按钮加上下 20px 留白，采用 clamp 上限而非固定 min-height。统一处理 bottomInset，避免与原正文底部留白重复。
- 行动组件样式脱离 `.sr-story .sr-suggestions` 和 WorldStory 私有变量，使用公共主题变量。
- 不增加“故事”或行动项专用顶栏。
- 有自定义 Stage 时只渲染作者 Stage，平台不额外强插官方行动区。

依据：[当前 frame 默认入口](../apps/web/src/frame.tsx)、[当前 WorldStory](../packages/sr-sdk/src/stage/world-story.tsx)、[当前阅读样式](../packages/sr-sdk/src/world-story.css)。

## 4. 作者自由组合与点击

作者可以复用官方组件，也可以用 Hook 编写自己的按钮、菜单、侧栏或面板。世界卡继续使用已有组件注册、普通组件导入和 stage_component；不增加 message_render.action_suggestions 或专用 renderer ID。

~~~tsx
function InnStage() {
  const {items} = useSRActionSuggestions();
  return (
    <div className="inn-stage">
      <div className="inn-story">
        <SR.WorldStory showState={false} />
      </div>
      {items.length > 0 && <InnActions />}
    </div>
  );
}
~~~

自定义视图的最小示例（实际源码正常从 React 与 SDK 根入口导入）：

~~~tsx
function InnActions() {
  const {items} = useSRActionSuggestions();
  const session = useSRSession();
  const busy = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');

  async function choose(text: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await session.setDraft(text);
      // 作者若希望直接行动，改为 await session.send(text)。
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section className="inn-actions" aria-label="行动建议">
      {items.map((text, index) => (
        <button key={index} type="button" disabled={pending}
          onClick={() => void choose(text)}>
          {text}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
~~~

本例 pending/error 仅为局部交互。发送中、运行中、连接等通用会话状态，如 UI 需要可从已有会话快照读取；实际命令仍由 Host 检查。**本功能不新增通用会话状态 API，更不把这些字段放回建议 Hook。**

默认官方组件继续 setDraft：替换并展开草稿，不直接生成消息。作者调用 send 时直接提交普通文本，不先 setDraft、不清除玩家原有草稿。沿用现有 SDK/Host/服务端准入与运行锁，不引入建议来源 token、专用发送命令或固定 tip 分支。

## 5. 接受回执：清空与用户消息必须同批发布

### 5.1 本地提交的主路径

1. 用户点击发送，HTTP 尚未接受：保留当前建议，按已有发送状态处理 UI。
2. 收到成功的 accepted 回执：表明用户消息已保存、执行已接受。
3. Host 在同一次接受处理内完成：
   - 把回执中的 userMessage 交给消息展示；
   - 把当前行动建议置为 []；
   - 更新本次执行状态。
4. 将组合后的同一份展示快照发给舞台。
5. 此后新建议由本次执行的 SSE 事件注入。

不能先向舞台发布“新用户消息 + 旧建议”，再下一次更新清空；也不等待首段 AI 输出或后续 run.created 才清空。workspace 是已有组合边界，应在那里合并接受处理的发布，不靠 React/RAF 偶然合批。

[workspace.onAccepted](../apps/web/src/features/sessions/workspace.ts) 继续连接 history.acceptExecution 和 suggestions.begin；workspace 的同步发布批次已将接受处理与 narrative 状态更新合并为同一份快照，不跨 HTTP 等待暂停发布。

### 5.2 SSE 确认和补偿

HTTP 成功是本地正常路径，但不能忽略：

- SSE run.created 先于 HTTP 返回；
- HTTP 超时或丢失，而服务端实际上已经接受；
- 其他窗口启动了新执行。

这些情况仍由 SSE 调用**同一 Host 接受入口**，完成相同的用户消息确认/补偿和清空。后到的 HTTP/SSE 只是重复确认，不再次清空。

去重继续使用本次 assistantEntryId；不能只用 runId，因为重生成会复用 runId。复用现有 narrative receipts/acknowledge，并让 suggestions.begin/run.created 在同执行上幂等。

特别要覆盖：

~~~text
SSE 接受 R → 清空 → 新建议到达 → R 的 HTTP 回执迟到
~~~

最后一步不能把 R 已到达的新建议清掉。已结束执行的迟到回执也不能重新启动或覆盖更新执行。

依据：[现有接受回执与去重](../apps/web/src/features/narrative/controller.ts)。

### 5.3 不新增额外发送协议

accepted 表示受理成功，不表示模型完成；创建成功后即使生成失败，上一轮建议也已失效。请求明确未受理则保留原建议；超时结果未知由 SSE/宿主同步确认，不能自动重发。

## 6. 最小恢复实现：复用现有历史加载

**本期保留现有会话读取与历史加载链路，不新增 bootstrap、建议专用接口或额外恢复请求。** 已有 entries 包含助手消息的 `extData.output.actionSuggestions`，不需要数据库字段、迁移、新持久化状态或服务端改动。

继续使用当前 Host 流程：

1. `workspace.start()` 建立既有会话事件通道，并通过 `synchronize()` 协调读取。
2. `synchronize()` 在异步读取前捕获 `suggestions.checkpoint()`，沿用已有 `refreshSession()` 与 `history.loadRecent(reset)` / `history.catchUp()`。
3. 从已排序的 `history.getSnapshot().runs` 取最新一轮，即现有 `runs.at(-1)`。
4. 调用既有 `suggestions.restore(latest, checkpoint)`，按第 7 节规则取得当前建议。
5. Host 将处理后的 items 投影到 StageSnapshot，舞台 Hook 只读取最终状态。

首次进入和整页刷新复用 `start()` 的同步流程；连接建立、重连及显式刷新继续使用现有 `synchronize(true)`。首屏仍按既有规则加载最近 5 轮，不为恢复建议读取全部历史，也不另外请求一次建议。

最小改动集中在：纠正 `savedSuggestions` 的末条普通消息判断，以及将 Host 的展示结果映射为仅含 items 的 SDK 契约。保留已有 checkpoint 防止较旧读取覆盖新状态，不重构历史加载器，不新增恢复 Store、Provider 或服务。

统一会话初始化接口留作将来独立评估的加载优化，不是本次组件拆分与刷新恢复的前置条件。

依据：[现有会话协调](../apps/web/src/features/sessions/workspace.ts)、[现有历史加载](../apps/web/src/features/history/controller.ts)、[现有建议恢复](../apps/web/src/features/suggestions/controller.ts)。

## 7. 宿主如何从最新消息恢复

“最新消息”定义为：**本会话按 seq 最新的一条普通 message**，不包含隐藏 compaction；也不是“往前找最近一条有建议的 assistant”。

Host 对现有 history 加载结果做一次投影：

1. 复用 history 已整理好的顺序，从最新 run 中取最后一条普通 message；没有普通消息则 items=[]。原始 HTTP 分组顺序不作为判断依据，也不在建议模块新增第二套排序逻辑。
2. 当前执行未完成，或最后消息为 user：items=[]。
3. 最后消息为 assistant，但所属执行停止/未知、没有有效 actionSuggestions、状态失败或数组为空：items=[]。
4. 最后消息为有效完成的 assistant，actionSuggestions 为 success/partial_success 且有有效非空项：注入这些 items。
5. 不回找更早助手，不跨轮补旧建议。

savedSuggestions 已改为先确定最新 run 真正最后一条普通 message，再判断角色与有效结果，避免跳过最新 user 又显示旧助手建议。

进入会话、整页刷新、重连和明确的会话重新同步继续由 Host 的既有协调入口加载历史并恢复建议；历史向上翻页不触发建议恢复。组件完全不关心数据来自历史读取还是实时事件。

服务端仍保存 actionSuggestions，以供宿主恢复、模型历史提示和诊断。展示解耦不改变存储协议。

## 8. 初始化结果与实时事件如何衔接

统一原则：**所有数据都经过同一个 Host 建议状态，舞台只看最终快照。**

~~~mermaid
flowchart TD
  A["现有历史加载 / 刷新结果"] --> D["Host 当前建议状态"]
  B["HTTP 接受 / SSE 创建补偿"] --> D
  C["SSE 行动建议"] --> D
  D --> E["StageSnapshot 与只读 Hook"]
  E --> F["Stage 按 items 条件挂载组件"]
~~~

沿用现有 checkpoint/revision 即可：

- 沿用 synchronize 在异步读取前捕获的 Host 当前修订，不另增一轮读取。
- 如果读取期间已接受新执行或注入新建议，旧响应不得把旧 items 覆盖回来。
- HTTP/SSE 接受、实时建议、初始化恢复都在 Host 去重并判定顺序，SDK 不做第二遍合并。
- 继续先建立会话事件通道，并在连接建立/重连后执行同步；不能改成“HTTP 初始化完才开始连 SSE”，以免出现读取与订阅之间的空窗。
- 需要重新协调时复用当前同步入口，不引入新的事件序号协议、回放队列或恢复服务。

同一次本地更新中合并 userMessage 与 items=[] 的要求同样适用恢复：晚返回的旧历史读取不能让新接受的用户消息或清空结果倒退。

仅 iframe 重挂载时，Host 仍然存活，直接再次注入当前快照即可，无需让组件再发初始化请求。

## 9. 生命周期表

| 情形 | Host 对 items 的处理 |
| --- | --- |
| 进入会话 / 整页刷新 | 初始 []；现有历史加载完成后由 Host 按最新消息恢复 |
| 新执行 HTTP 接受成功 | 与用户消息展示同批置为 [] |
| run.created 先到 / HTTP 丢失 | 同一接受入口补偿；同执行只清空一次 |
| 收到本次有效建议 | 整体替换 |
| 本轮没有有效建议 | 保持 [] |
| run.completed | 不无条件清空已经到达的建议 |
| 本轮停止/失败 | 本轮没有有效结果则为空，不恢复上一轮 |
| 明确未受理的请求失败 | 保留已有建议；不凭点击就清空 |
| 断线 / 重连 | 断线保留现有建议状态；重连后通过既有 synchronize(true) 同步并恢复，不新增断线清空行为 |
| 历史向上翻页 | 不变 |
| 状态、usage、正文 delta | 不变 |
| 作者组件卸载 / 重挂载 | 不改变 Host 状态 |
| 只重挂载 iframe | 获取 Host 当前快照 |

建议事件先于 run.completed 是当前服务端既有顺序，因此不能在每次终态无条件清空。依据：[发布顺序](../apps/server/src/usecases/narrative/start.ts)。

Host 内部继续保留当前会话/执行过滤，忽略已知旧执行事件；不向 Hook 暴露消息身份，也不用它决定 DOM 位置。初始化数据会帮助建立当前执行身份；生成途中进入时也不能仅因错过 run.created 而拒绝随后合法建议。

## 10. 兼容与实现边界

- 移除 WorldStory 的建议 JSX、消息匹配参数和 chooseSuggestion；官方默认入口改成组合布局。
- 保留 Host 现有历史读取、建议恢复和 checkpoint，通过既有同步入口注入；仅收紧末条普通消息判断，纠正 V2 的“删除恢复”要求。
- StageSnapshot 的作者展示契约改为仅 items；直接依赖旧 runId/messageId 的作者代码须迁移到 Hook。
- 无自定义 Stage 的世界自动使用默认组合。
- 自定义 Stage 若原来只放 WorldStory，需要显式增加条件挂载的官方/作者行动区；首个示范为小饭馆。
- 更新发行 ZIP 不会自动更新已导入实例；当前公开导入会创建新世界，管理 PATCH 不支持替换组件，初始化也会跳过已有内置 ID。本次只更新发行包和示例，既有自定义 Stage 需后续明确适配，不通过删除世界或会话实施迁移。
- 不增加世界卡 action_suggestions 绑定配置，不改变 message_render/正则组件契约。
- 不改服务端建议解析、持久化与既有事件，不新增服务端接口；不为本次恢复修改会话客户端或历史加载器的读取契约。
- 普通 setDraft/send 继续使用现有协议和最终检查，不增加建议专属权限或来源校验。
- 作者预览没有运行期会话 Provider，不开放会话 Hook；不要用静默 [] 掩盖调用环境错误。
- 正式 SDK/运行时/创作者文档、设计规范与 AGENTS 边界说明已与实现同步。仓库创作技能原有指引未包含旧建议职责，因此无需修改。

## 11. 实施变更目录

以下为本次已实施范围。没有删除源文件；旧内联建议 JSX、消息定位代码和私有建议样式在原文件内移除。

~~~text
仓库根/
├── plan/action-suggestions-components.md                 [修改] V4 方案与完成记录
├── AGENTS.md、apps/web/AGENTS.md                          [修改] Hook/Host/布局职责
├── apps/web/src/
│   ├── default-stage.tsx                                [新增] 条件挂载整个行动区
│   ├── frame.tsx、frame.css                              [修改] 默认组合入口、伸缩布局与输入框避让
│   ├── features/suggestions/controller.ts                [修改] 末条消息恢复、执行幂等与整体替换
│   ├── features/sessions/workspace.ts                    [修改] 同批接受发布与纯 items 投影
│   └── features/narrative/controller.ts                  [修改] 统一接受回执的同步发布边界
├── packages/sr-sdk/
│   ├── package.json                                     [修改] 独立行动样式入口
│   └── src/
│       ├── stage-contract.ts                            [修改] 仅 items 的 ActionSuggestionsState
│       ├── action-suggestions.css                       [新增] 独立组件样式
│       ├── world-story.css                              [修改] 删除建议样式、公开组合布局变量
│       └── stage/
│           ├── action-suggestions.tsx                   [新增] 官方视图与 setDraft 点击行为
│           ├── context.tsx                              [修改] useSRActionSuggestions
│           ├── runtime.ts                               [修改] 非空对象的初始建议快照
│           ├── index.tsx                                [修改] 导出 Hook/类型/组件
│           └── world-story.tsx                          [修改] 移除行动建议职责
├── apps/web/tests/
│   ├── suggestions.test.mjs、session-workspace.test.mjs  [修改] 恢复、去重、同批发布、旧响应隔离
│   ├── narrative.test.mjs、stage-frame.test.mjs          [修改] 接受批次与不可变展示镜像
│   └── action-suggestions.test.mjs                      [新增] 真实 React SSR 与命令委托验证
├── docs/
│   ├── sdk/{README,components,session}.md               [修改] Hook/组合与恢复语义
│   ├── creator/{README,presentation}.md                 [修改] 作者接入指引
│   ├── runtime/web-runtime.md                           [修改] Host 恢复与注入职责
│   └── design/{world-components,UI-SPEC}.md              [修改] 独立行动区与输入区避让
├── examples/worlds/
│   ├── fog-harbor/components/HarborStage.tsx              [修改] 显式组合行动区
│   └── packages/fog-harbor.zip                           [修改] 同步可下载示例
└── initial-data/worlds/小饭馆.zip                         [修改] InnStage 条件挂载官方组件
~~~

## 12. 验收重点

1. Hook 仅含 items，无 canSetDraft/canSend、消息 ID 或 setter。
2. 没有 WorldStory 也能使用行动组件；多个消费者不建立额外连接。
3. items=[] 时官方行动组件及有视觉样式的 wrapper 均未挂载，无边框、padding、gap 或空占位。
4. HTTP accepted 后，下一份舞台快照同时具有新用户消息与空建议，不等待 SSE。
5. SSE 先到、HTTP 超时、其他窗口发起均能补偿；相同执行重复确认不再清空已到达的新建议。
6. run.completed 不擦掉刚收到的建议；本轮无建议、失败或停止时不回捞上一轮。
7. 进入/刷新/重连由 Host 复用现有历史加载与 suggestions.restore 恢复，不新增初始化或建议请求；最后消息为 user 或助手无有效建议时为空。
8. 原始分页顺序、隐藏摘要、同轮重生成均不导致选错最新消息。
9. 初始化过程中接受新轮/收到建议，晚返回的旧读取不能覆盖当前状态。
10. 顶层条件卸载、iframe 重挂载、历史翻页不导致第二套建议恢复或重复副作用。
11. 官方默认填草稿，作者可直发；发送错误按既有 API 处理，不修改数据 Hook。
12. 布局在窄屏、长文本、多项和输入框展开/收起时不溢出或遮挡正文。

上述验收已通过针对性的函数／组件检查、类型检查和静态构建；真实浏览器视觉与实际应用导入／试玩不包含在本轮验证中，详见以下记录。

## 13. 实施结果与验证

- SDK 提供纯数据 useSRActionSuggestions 与独立 SR.ActionSuggestions。官方组件默认填草稿；作者可调用普通 send，Host 仍是业务状态唯一所有者。
- 默认 Stage 与小饭馆／雾港均以兄弟组件组合正文和行动区，items 为空时移除整个行动 wrapper。外壳只避让一次输入区，正文尾白和局部控件通过公开变量调整。
- HTTP/SSE 接受使用现有执行身份去重并同批发布，重复确认不清空新建议。既有 history/restore/checkpoint 完成刷新恢复；没有新增接口、请求或服务端数据结构。
- 两个 ZIP 的逐成员字节比对确认：小饭馆 26 个文件中仅 InnStage.tsx 改变，雾港 9 个文件中仅 HarborStage.tsx 改变；world.json、其他组件、素材和成员清单均保留。

| 检查 | 结果 |
| --- | --- |
| pnpm test:web | 193 项通过，0 失败、0 跳过；包含真实 React SSR、命令委托、Host 接受与恢复 |
| pnpm --filter @sillyrealms/web build | TypeScript 与主站／隔离舞台两个静态构建通过 |
| 最终低高度布局的 world-preview 构建 | 通过，独立行动样式纳入舞台产物 |
| pnpm lint | 通过 |
| 小饭馆、雾港源码及最终 ZIP 的 world:check / world:pack | 通过；无世界定义或素材变化 |
| git diff --check | 通过 |

遵守仓库函数级验证约束，没有启动真实服务、浏览器或模型，没有实际导入／试玩，没有修改已导入世界、会话或数据库。本轮交付为代码、文档与发行包；服务端部署和既有自定义舞台的数据适配需单独执行。
