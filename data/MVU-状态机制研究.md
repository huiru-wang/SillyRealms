# MVU 变量框架：运行逻辑与状态快照机制

> 资料性质：SillyTavern / MagVarUpdate（MVU）源码研究与 SillyRealms 的状态设计参考，不代表 SillyRealms 已实现 MVU。
>
> 研究日期：2026-11-01。核对的上游版本：MagicalAstrogy/MagVarUpdate `beta` 分支，提交 `d03b7dc`（2026-10-19）。
>
> **当前讨论决定：SillyRealms 若引入状态能力，优先采用“每条消息保存完整状态快照（允许冗余）”，不优先采用仅存 Patch + 定期快照。** 这是一项设计倾向，不表示状态模块已开始开发。

## 1. 总结

MVU 并不是不断自主推演世界的模拟器，而是一个以聊天消息为结算单位的 **状态维护框架**：

1. 通过世界书的 `[initvar]` 或开场白的 `<initvar>` 初始化变量与 Schema。
2. 为模型提供当前变量和更新规则（通常依赖角色卡世界书中的变量宏和提示词配置）。
3. 每条可处理的消息完成时，读取上一条**有效状态**，解析本轮变量更新指令，生成当前状态。
4. 将更新后的完整变量数据附着到当前消息（对应 Swipe）上；没有状态变化时，仍然通常复制并保存相同的 `stat_data`。
5. 下一轮只需取最新有效状态，无须让模型阅读整段历史重新推算变量。
6. 如有需要，可清理远古楼层的部分冗余快照，并从保留快照与历史更新指令重放恢复；这项清理是可选的。

**关键边界：模型负责理解剧情中“应不应该变”，插件负责解析与应用“怎么变”。因此状态更新可以被结构化校验，但不可能天然保证语义完整性或真实性。**

## 2. 术语与数据归属

- **世界书 / 变量规则**：定义变量初始化内容、更新条件和提示词，不代表某段剧情已发生。
- **`stat_data`**：本楼层完整有效状态；供下一轮读取。
- **`schema`**：当前变量结构的描述；初始状态可生成 Schema，更新后可能重新调和。
- **`display_data`**：界面展示值，可包含“旧值→新值（原因）”。
- **`delta_data`**：本轮变化摘要；不等于下一轮所需的完整状态。
- **`initialized_lorebooks`**：已初始化的世界书记录。
- **消息楼层**：SillyTavern 消息序列中的某条消息。
- **Swipe**：同一条助手消息的不同候选回复；MVU 的状态按当前 `swipe_id` 选择。

当前源码 `MvuData` 类型里 `display_data`、`delta_data` 已被标记为 deprecated，但实现仍然会计算和保存它们。不要把这两个字段当成长期稳定的、必须遵循的公共协议。

## 3. 初始化：状态从哪里来

调用 `initCheck()` 的入口包括：

- 加载当前聊天并初始化聊天级 MVU 模块；
- `GENERATION_STARTED`；
- `MESSAGE_SENT`。

初始化流程读取已经存在的最近有效状态。若需要初始化，则合并启用世界书中的 `[initvar]` 条目；开场白中的 `<initvar>` 还可以为不同开局或 Swipe 提供覆盖的初始状态。随后生成/维护 Schema 并把状态写入消息变量。

在 `initvar` 合并路径上，用 `initialized_lorebooks` 避免对同一本已初始化的世界书反复应用初始值。状态初始化规则和剧情更新规则应分开理解。

## 4. 每轮触发流程

### 4.1 消息和生成事件

| 触发点 | MVU 行为 |
| --- | --- |
| `CHAT_CHANGED` | 卸载旧聊天监听，初始化新聊天的 MVU 模块，避免跨会话写回 |
| `GENERATION_STARTED` | 运行初始化检查 |
| `MESSAGE_SENT` | 初始化检查，并尝试从用户消息更新该楼层变量 |
| `MESSAGE_RECEIVED` | 对 AI 消息进行变量处理；可能调用额外模型 |
| `CHARACTER_MESSAGE_RENDERED` | 在部分非阻塞额外解析模式下，以消息渲染完成为写回衔接点 |

更新通常以 **整条消息**为单位，不是每生成一个 Token 更新一次变量。

接收处理里有必要的跳过/保护，例如空或极短消息、开局第一楼的额外模型跳过、自动请求关闭、最小字数、触发标签不匹配、消息已经更换 Swipe、聊天已经切换或异步请求被取消。**因此“所有真实消息必然都有快照”不是对 MVU 原版所有运行分支的无条件保证。**

### 4.2 两种更新模式

**A. 随 AI 输出**

剧情模型在同一回复中输出正文与变量指令，MVU 在回复完成后解析指令并结算状态。优点是成本较低；缺点是剧情与状态分析抢占模型注意力，可能遗漏。

**B. 额外模型解析**

先让剧情模型完成叙事，再调用独立的变量解析请求。可以根据世界书条目名中的 `[mvu_plot]` / `[mvu_update]` 分配剧情提示词与更新提示词。额外解析还支持条件触发、独立模型配置、结构化格式或工具调用模式等。

额外模型能够降低“剧情模型没空管状态”的问题，但依然不能保证模型对剧情的语义判断正确。

### 4.3 状态计算核心

下面是为了理解而写的**等价伪代码**，不是可直接复制进项目的函数体：

~~~ts
async function processMessage(messageId: number, messageText: string) {
  // 查询 [0, messageId) 中最近一个带有效 MVU 状态的楼层
  const inherited = getLastValidVariable(messageId);
  if (!inherited) return;

  const current = deepClone(inherited);

  // 未发现任何有效更新命令时，current.stat_data 仍与继承状态相同
  await updateVariables(messageText, current);

  // 正常进入处理流程时，写回当前消息对应 Swipe 的变量数据
  await updateVariablesWith(
    data => ({
      ...data,
      initialized_lorebooks: current.initialized_lorebooks,
      stat_data: current.stat_data,
      schema: current.schema,
      display_data: current.display_data,
      delta_data: current.delta_data,
    }),
    { type: 'message', message_id: messageId },
  );
}
~~~

真实 `handleVariablesInMessage` 中对 `message_id=0` 有专门处理，还涉及事件回调、状态栏占位符、聊天变量兼容写入、消息内容刷新等操作；以上代码只突出状态继承与落盘过程。

## 5. 重点：本轮没有状态变化时会发生什么

**正常进入 `handleVariablesInMessage` 时，即使 `updateVariables` 没有发现命令或 `stat_data` 没发生变化，仍然执行当前楼层的 `updateVariablesWith(..., {type:'message'})`。**

它不会因为 `updateVariables()` 返回 `false` 就直接跳过消息级状态写入。

示例（简化）：

| 楼层 | 内容 | 保存的完整状态 |
| --- | --- | --- |
| #10 助手 | 艾琳来到森林 | `{位置: 森林, 好感度: 30}` |
| #11 用户 | 询问天气 | `{位置: 森林, 好感度: 30}` |
| #12 助手 | 描写森林天气 | `{位置: 森林, 好感度: 30}` |
| #13 用户 | 赠送礼物 | `{位置: 森林, 好感度: 30}` |
| #14 助手 | 艾琳收下礼物 | `{位置: 森林, 好感度: 35}` |

所以 **“本轮状态不变”** 与 **“本轮不存在状态快照”** 是两件不同的事：

- 已处理、无变化：本轮通常仍保存完整状态，只是值与上一楼一致。
- 根本没进入处理、被跳过、失败，或被历史清理：当前楼层可能没有有效完整状态；读取时需要回退。

`delta_data` 在没有命令时通常为空，本轮的 `stat_data` 仍是完整状态。

## 6. 如何查找最近状态，以及提供给模型

### 6.1 MVU 插件查找状态

`getLastValidVariable(end_message_id)`：

1. 仅检查当前楼层**之前**的消息（`[0, end_message_id)`）。
2. 倒序寻找当前选中 Swipe 的变量对象同时包含 `stat_data` 与 `schema` 的最近楼层。
3. 深拷贝该状态，作为本次更新的输入。

查找的是**有效楼层快照**，不是重新让 LLM 从历史对话推理世界状态。

~~~text
消息 #10：S10（完整状态）
消息 #11：S11（同值快照）
消息 #12：无有效快照（被跳过或清理）
消息 #13：准备结算

getLastValidVariable(13) → 查 #12 → 查 #11 → 复制 S11
~~~

源码读取的是选中 Swipe：`chat[messageId].variables[chat[messageId].swipe_id ?? 0]`。Swipe 选择不同，可能读到不同结果。

### 6.2 模型拿到最新状态的方式

MVU **维护数据**，但不意味着插件会无条件自动把全部状态注入每一次剧情模型的 Prompt。

常见的角色卡会在世界书的变量规则条目中使用酒馆助手宏：

~~~text
<status_current_variable>
{{get_message_variable::stat_data}}
</status_current_variable>
~~~

随后在构建模型请求时解析宏，把变量值、变量含义和更新条件作为提示词的一部分交给模型。模型看到的是被注入的**状态值**，而不是自己对所有历史楼层做一次状态重算。

注意：`get_message_variable` 属于宿主/酒馆助手变量能力，不等同于直接调用 MVU 的 `getLastValidVariable`；不同宏、插件版本及状态缺失时的 fallback 行为可能有差异，不能混为一谈。

模型下一轮的状态应取**当前有效末端消息结算之后**的快照；提示词中历史状态栏或旧变量更新指令不应与最新状态互相竞争。

## 7. 变量更新指令与执行

MVU 当前的核心解析器支持兼容的脚本式更新指令，以及特定的 JSON Patch 形式，例如：

~~~text
<UpdateVariable>
_.set('角色.艾琳.位置', '森林'); // 实际进入森林
_.add('角色.艾琳.好感度', 5); // 对赠礼表示好感
</UpdateVariable>
~~~

主要操作：

| 操作 | 作用 |
| --- | --- |
| `set` | 设置已有路径的值 |
| `insert` | 向数组或对象插入内容 |
| `delete` | 删除变量或集合元素 |
| `add` | 数字增减/日期位移等 |
| `move` | 移动集合元素 |
| JSON Patch 方言 | 结构化表达替换、增量、添加、删除、移动 |

插件会扫描命令、检查部分格式与路径约束、应用 Schema 相关逻辑、触发插件事件，之后形成新状态。

**容易误解的一点**：三参数 `_.set(path, oldValue, newValue)` 在所核对版本中，并未实现“当前旧值必须与 oldValue 相等才允许更新”的 CAS 校验，不能视为解决并发覆盖的机制。

## 8. 如何减少错更与漏更，以及无法保证的部分

### 8.1 能做到的

- 解析器对部分非法格式、缺失路径、不合适的集合操作作防御。
- 初始数据生成 Schema；可通过外部 MVU Zod 扩展更严格的业务校验。
- 生命周期事件供第三方脚本修正命令、限制数值变化或修改状态：
  - `COMMAND_PARSED`
  - `VARIABLE_UPDATE_STARTED`
  - `VARIABLE_UPDATE_ENDED`
  - `BEFORE_MESSAGE_UPDATE`
- 对聊天切换、Swipe 切换和部分异步写回设置身份检查，减少写错消息的可能。
- 额外模型支持重新解析当前楼层，以及增量校正遗漏/错误项（含预览、确认、撤销和过期结果检查）。

### 8.2 不能保证的

- 模型是否识别了剧情中**所有**应改变的变量。
- 模型是否把心理/关系/位置等主观状态判对。
- 某个自由文本叙事事件是否被模型重复计数。
- 下一次叙事是否严格遵循最新状态。
- 任意第三方脚本都符合当前变量类型与业务规则。

**结论：语义更新由 LLM 提议，结构与部分边界由程序维护；MVU 不是严格事务化、完备的世界状态规则引擎。**

## 9. 历史快照清理与恢复（MVU 可选机制）

MVU 的正常消息写入是冗余的完整状态快照，但还提供“自动清理变量”的可选机制：

1. 保留最近若干消息的状态。
2. 旧消息按间隔留下带 `snapshot` 标记的完整快照。
3. 对部分中间楼层删除 `stat_data` / `schema` 等冗余字段。
4. 必要时，从最近可用历史快照开始，按消息顺序执行其中的变量命令以重建状态。

恢复逻辑见 `cleanup/restore_variables.ts`；它是通过**重放变量指令**恢复，不是重新找模型生成剧情。

这种机制节约空间，但增加了历史状态重建成本，还依赖历史消息文本、指令与重放规则的一致性。

## 10. SillyRealms 的设计取舍：优先每条消息完整快照

> **决策（2026-11-01）：为了读取简单、历史可检查和分叉独立性，优先保存每条消息的完整状态快照。**
>
> 以下是参考 MVU 的**建议方案**，不是对上游已有行为的描述，也不是本项目已经实现的功能。

### 10.1 存储原则

- 状态归属**世界实例（Session）的具体消息节点（Entry）**，而非世界卡定义本身。
- 每个已提交消息节点有一份自己的完整有效状态（无变化仍保存相同内容），避免跨节点可变引用。
- 不需要为了节约存储而跳过无变化快照；状态小/中等规模时，读取简单性优先。
- 可以额外存储 `patch / change_log / update_reason` 用于调试、UI 和审计，但它们不是读取当前状态的必需条件。
- 保留 `schema_version / state_version / source_message_id / parent_entry_id` 等必要元信息，便于迁移和检查因果关系。
- 状态字段和持久化表结构待后续独立设计，不在本研究中定稿。

### 10.2 适配父子消息树

MVU 原生按线性消息楼层向前查找最近有效快照；SillyRealms 消息是**父子树**，必须改为沿父链继承，不允许跨分支向前寻找“全局最近状态”。

~~~text
父节点 A：S_A = {位置: 酒馆, 好感度: 30}
  ├─ 分支 B：S_B = {位置: 森林, 好感度: 30}
  │    └─ 分支 D：S_D = {位置: 森林, 好感度: 35}
  └─ 分支 C：S_C = {位置: 酒馆, 好感度: 30}
       └─ 分支 E：S_E = {位置: 酒馆, 好感度: 30}
~~~

分叉 C 继承 A 而**不是** B；分叉 E 继承 C 而**不是** D。子节点独立保存自己的完整状态。

### 10.3 建议的每轮处理顺序

1. 用户沿某个叶子继续：确定 `parent_entry_id`，读取该父节点的**完整状态**。
2. 在用户输入成为一个已提交的消息节点时，为它保存继承后的完整快照；如允许用户消息本身带显式状态命令，则先校验执行。
3. 构建叙事模型 Prompt：注入此分支当前状态和有必要的世界书/历史，不注入其他分支状态。
4. AI 输出并确定本轮正文后，触发状态分析（随输出或额外模型，可作为可配置能力）。
5. 以**本分支父节点状态**为基准应用更新；无变化时直接复制完整状态。
6. **消息正文与该消息快照一同提交**，保证状态版本与正文对应；失败时留明确的未结算状态，不把“未经结算”伪装成“确认无变化”。
7. 后续交互直接读取当前叶子的状态快照，避免回放所有历史。

在同一个消息上重试状态解析，应有消息版本检查，避免异步旧结果覆盖新正文/新状态；多次执行同一更新不能重复增加数值或物品数量。

### 10.4 示意持久化形状（非最终 schema）

~~~json
{
  "entry_id": "entry-014",
  "parent_entry_id": "entry-013",
  "role": "assistant",
  "content": "艾琳收下礼物，露出了微笑。",
  "state": {
    "status": "settled",
    "state_version": 3,
    "schema_version": 1,
    "snapshot": {
      "characters": {
        "ailin": {
          "location": "forest",
          "affection": 35
        }
      }
    },
    "changes": [
      {
        "path": "characters.ailin.affection",
        "before": 30,
        "after": 35,
        "reason": "收下礼物"
      }
    ]
  }
}
~~~

若本轮没有变化，`snapshot` 仍完整存在，而 `changes` 为 `[]`。

对“客户端改历史剧情后续分支怎么处理”“状态冲突时模型内容与确定性规则谁优先”“展示给模型的字段是否包含角色秘密”等问题，后续需要单独决策；不要只因为 MVU 有状态存储，就误认为这些问题已解决。

## 11. 源码索引

上游仓库： https://github.com/MagicalAstrogy/MagVarUpdate

| 主题 | 源码（beta 分支） |
| --- | --- |
| 聊天生命周期初始化 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/main.ts |
| 发送、接收事件监听 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/function/update/index.ts |
| 接收消息 / 额外模型分流 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/function/update/on_message_received.ts |
| 命令解析、状态结算、每楼层写回 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/function/update_variables.ts |
| 向前查找最近有效状态 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/util.ts |
| 初始化与世界书初始变量 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/function/initvar/variable_init.ts |
| MVU 数据结构/事件接口 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/variable_def.ts |
| 历史清理/恢复 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/function/cleanup/restore_variables.ts |
| MVU 官方教程 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/doc/tutorial.md |
| 历史方案解读 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/doc/stat_var.md |
| 更新方式说明 | https://github.com/MagicalAstrogy/MagVarUpdate/blob/beta/src/panel/update_method.zh-CN.md |

**文档边界**：本文件记录 MVU 的运行逻辑、已核对的源码行为以及 SillyRealms 的状态存储取舍。项目自身的产品总纲仍以 `docs/PRODUCT.md` 为准，具体实现另行设计，不应直接将本研究当作已经落地的程序行为。
