# Server 叙事后处理方案

状态：已完成（实现与验证）。2026-11-20 按最后确认的独立标签规则完成实现、函数验证、typecheck、lint 与文档核对。

任务：[server-narrative-output-tasks.md](server-narrative-output-tasks.md)。

## 1. 本版范围

一次叙事正文模型调用同时产生正文和可选能力数据块。服务端隐藏数据块、分别处理状态更新与行动建议，将干净正文和结构化结果保存到同一助手 entry。能力失败不改变正常叙事的 completed 终态。

本期仅涉及 Server、相关文档及仓库约束。Web 舞台与 SDK transport 另行适配，原 Server/Web 保持独立。不增加辅助模型调用、修复重试、恢复表或后台任务。

目录使用 `usecases/narrative/postprocess/`。`extData.output` 仍是保存的能力结果字段，与代码目录名称分开。

## 2. 协议与标签独立性

```text
店主收下铜钱，递来一碗热汤。

<state_update>
{"path":"coins","value":8,"reason":"购买食物"}
{"path":"inventory.soup","value":1,"reason":"获得热汤"}
</state_update>
<action_suggestions>
["继续询问店主。","去集市寻找线索。","动身前往城外。"]
</action_suggestions>
```

- 每个能力只匹配并校验自己的开始、结束标签，大小写不敏感。
- 正则提取完整标签对，并检查自身标签是否完整、配对。没有自身标记与存在损坏标记必须区分。
- **自己的开始或结束标签缺失、损坏、配对错误，整个能力为 invalid_tag，不执行其中的数据。**
- 不以另一个能力的标签作为截断或恢复锚点，不从损坏标签中的内容恢复更新。其他能力继续独立提取自己的完整标签。
- 整对标签都没有输出，以及成对标签内只有空白，均是正常无结果，不报错。
- 不要求不同能力的相对顺序；标签内容分别按所属能力的数据格式解析。
- 正文展示保留标签使用 HTML 实体；JSON 字符串中的保留标签使用 `\u003C`/`\u003E`，不以裸保留标记混淆数据和边界。

状态块使用 JSONL，每个非空物理行一个完整 `{path,value,reason?}` 对象，不用外围数组。字符串换行用 JSON 转义，空白行忽略；兼容单行 `<state_update> {"path":"coins","value":8} </state_update>`。

建议块保持 JSON 字符串数组。空标签、缺失标签或合法空数组 `[]` 表示无建议。状态块内 `[]` 是不符合对象协议的非空内容，不能代替空标签。

## 3. 展示隔离

流式隐藏与最终提取是不同阶段：

1. 流式阶段缓冲潜在保留标签前缀，支持大小写、跨分片和 UTF-16 代理对。
2. 遇到可识别的保留边界后，后续能力区域保持隐藏，不将数据块送入公开 content。
3. 最终模型快照重新分离，最终 snapshot、持久化正文与后处理输入使用同一份最终结果。
4. 不完整的保留前缀在中断时不补发；能力仅解析 content，reasoning/tool_calls 继续既有字段契约。
5. 每个能力的正则提取只检查自身标签；展示层发现其他标签，不代表可用其修复损坏能力。

完全无法辨认所属能力的任意拼写不猜测修复。摘要继续使用独立纯文本收集，不执行叙事后处理。

## 4. 各能力的结果状态

状态与建议独立定义结果类型，不共享强制二态枚举。整体 status 描述能力结果，stateUpdate.updates 按输入行序保存成功/失败记录及其 status，actionSuggestions.items 只保存有效建议；两类 output 都不保存 results。errors 保存能力级诊断。

### 4.1 stateUpdate

| 场景 | status |
| --- | --- |
| 缺失标签或空标签 | no_updates |
| 全部更新行有效（包括同值替换） | success |
| 有成功更新，也有失败行 | partial_success |
| 有内容但所有更新行无效 | invalid_updates |
| 自身标签损坏 | invalid_tag |
| 状态材料读取或能力计算异常 | processing_error |

每条 updates 记录使用 `success / invalid_json / invalid_update / invalid_path / invalid_value / processing_error`。成功项必须保留 path/value，可含 reason；失败项保留可用的 path/value/reason 和既有状态错误码、statePath/rulePath，不能虚构缺失字段。不再单独保存 results，也不持久化 blockIndex、line 或 index。

**invalid_tag 不执行该能力；partial_success 只用于标签完整后的逐行处理。** 任一行失败不回滚前后成功行。

### 4.2 actionSuggestions

| 场景 | status |
| --- | --- |
| 缺失标签、空标签或空数组 | no_suggestions |
| 所有建议有效 | success |
| 一部分建议有效、一部分无效 | partial_success |
| 自身标签损坏 | invalid_tag |
| JSON 无法解析 | invalid_json |
| JSON 不是数组或所有条目无效 | invalid_suggestions |
| 能力处理器内部异常 | processing_error |

空字符串或 trim 后为空、非字符串、长度或重复规则不通过的项直接过滤，保留其他有效建议。只保存能力整体 status、有效 items 和可选能力级 errors，不保存逐项 results。

提示词要求优先生成三个建议，服务端不因有效项不足三个拒绝整组。每条 trim 后不超过 50 个 Unicode 码点，去除重复建议。`[]` 是正常无建议；`[""," "]` 是无效条目组成的数组。

## 5. 状态处理与异常隔离

仅允许 message scope 和最终上下文激活的根，路径必须存在。value 完整替换，不创建节点、不合并对象、不支持数组索引，null 不代表删除。公共 PATCH 的缺失路径忽略语义保持不变。

每个非空 JSONL 行依次执行：JSON 解析、更新对象检查、路径和值/rules 校验、结果规范化、接受候选副本。失败只影响本行，候选保持该行执行前的值；成功行顺序覆盖重复路径并保留非目标状态与元数据。

StateService.prepareMessageUpdates 复用现有规则和快照处理，只返回候选、成功更新、逐项结果和变化信息，不写库、不发事件。自然语言 reason/rules 不当作可执行条件。

各能力有独立异常边界，状态内部再逐行隔离。状态定义或基础读取失败只影响状态能力，建议继续；建议错误不影响有效状态。每行规范化在接受候选前完成，stateUpdate.updates 中 status=success 的记录须与实际候选一致；失败记录只作诊断。

正常模型 stop、干净正文有效且主流程保存成功时，即使所有能力失败仍 completed。模型错误、length、取消、工具请求、正文无效、tip 冲突、正文/终态持久化错误仍使用主流程原语义。模型未正常完成时不执行能力，保存的部分助手不生成 output，不另造“未处理”状态。

## 6. 提示词与预算

- PresetService 公开 resolvePostprocessPrompts；默认能力缺失或提示词为空时补默认值，忽略旧 enabled 开关，保留非空用户提示词，不改旧预设 revision。
- 编译时提供本轮最终激活状态、能力指令和固定协议。固定协议明确覆盖旧提示词中的数组状态格式、强制非空标签或必须三条的要求，并明确状态更新不设固定条数上限。
- 后处理提示词不能引用 input.text、history.messages 或 history.summary；编译拒绝这类引用，避免当前输入、历史消息或摘要被重复注入。history.summary 仍由原上下文流程恰好注入一次。
- worldState 仅在存在激活 message 根时提供写入材料；行动建议按默认能力参与。
- 保留核心节点、自定义节点顺序与 ModelClient 消息顺序检查。
- 按模型实际输出处理，不另设能力 token、更新条数或全尾部大小配额。既有单值 JSON/深度校验局限于该行或该能力。
- 实际 usage 采用模型返回值，包含隐藏数据块；未知值不伪造成零，不按公开正文重算。
- 输入上下文预算与压缩继续由既有模块管理，实际提示词进入请求估算；不以输出 tokens 替代输入预算。

## 7. 保存与事件

SessionService.appendNarrativeAssistant 受控保存输出结果。普通 append/edit 禁止伪造或删除 output；其他 extData 修改保留它，正文编辑保留当时处理结果，不自动重做或回滚。

```ts
extData: {
  output: {
    stateUpdate: {
      status: 'partial_success',
      updates: [
        { path: 'coins', value: 8, reason: '购买食物', status: 'success' },
        { status: 'invalid_json', errorCode: 'STATE_UPDATE_JSON_INVALID' }
      ]
    },
    actionSuggestions: {
      status: 'partial_success',
      items: ['继续询问店主。', '离开酒馆。']
    }
  }
}
```

新写入严格使用上述结构。旧已保存 output 只在 SessionService 读取投影中归一化：按旧 results 的成功行顺序配对旧 updates，保留重复 path 及各自 value/reason，失败行不能变为成功；缺少可信成功载荷时记录 processing_error。旧建议仅移除 results。此读取适配不迁移或重写数据库，无 output 的旧 entry 不补造结果。

同步收尾事务校验实际 tip/parent，准备状态候选及变更信息，原子保存助手正文、output、state、metrics 并推进 seq/tip。实际变化保存完整 message 快照；无变化继续 null 继承。状态变更在追加前计算，不能在追加后读取“已经变化”的前驱并漏报事件。

用户和成功摘要不因后续失败回滚。用户终态仍独立保存；该保存失败时保留已提交助手/状态，并按主流程失败结算。能力失败不使有效行或另一个能力的结果回滚。

提交后、释放执行锁后、唯一终态前发布：

- 有真实状态变化：`state.changed`，`{scope:'message',path:'',value:完整有效状态对象}`。
- 有有效非空建议且本轮主流程完成：`action_suggestions.created`，`{sessionId,runId,messageId,items}`。partial_success 的有效建议同样可发布。
- 空结果不发 created；新一轮通过 `run.created` 清空旧建议，不新增空 created 或 cleared。
- 每条能力通知独立隔离发布异常，继续其他通知和 run.usage/终态，不回滚已提交结果。
- 主流程终态前只发一次总 usage；终态后不补发本轮能力通知。

既有 entries、轮次列表与单轮详情返回 output；不新增能力查询端点或表。首屏/重连只认最新 run 的实际结果，不回找旧建议冒充当前建议。

## 8. 输入上下文与模型旁注边界

输出后处理只保存干净正文与结构化 output，不承担历史重建、拼接或重复执行。聊天、关键词激活和摘要继续使用干净正文。

条目级 model-only notes 已转入独立[上下文方案](server-context-design.md)建设，由输入侧选择和组装。stateUpdate.updates、actionSuggestions.items 是两个内部来源：状态只读取 status=success 行的 path/value/reason，建议只读取有效 items；行状态和诊断不进入旁注，不依赖本模块解析器。旁注只进入本轮实际模型请求和输入估算，不改写历史，不新增 contextEligible、notes 表或持久化 schema。正文编辑保留当时处理结果的原有契约不变。

## 9. 实现职责与验收

| 模块 | 职责 |
| --- | --- |
| narrative/postprocess | 流式分离、各能力独立正则提取、内容校验和异常隔离 |
| context/stages/assemble | 本轮能力提示词和最终模型消息编译 |
| narrative/model-call、execute | 干净输出、收尾事务及通知编排 |
| modules/state | message 候选计算与通用状态规则 |
| modules/sessions | 输出结果类型、受控保存与编辑保护 |
| modules/presets | 默认提示词及公开解析 |
| infrastructure/events | 事件传输，不决定业务结果 |

验证使用函数级模型流替身、内存/临时 SQLite、typecheck、lint；不启动真实服务、HTTP/浏览器链路或模型请求。覆盖：

- 大小写、跨分片、最终快照修正及能力文本不泄露。
- 各能力只看自身标签：缺失、空、损坏、交错与其他能力独立；坏标签不恢复数据。
- JSONL 坏行、路径/值失败与内部异常不影响成功行；同值、重复路径与状态继承。
- 空建议过滤、保留有效 items 和能力整体状态；状态更新只保存一份带 status 的有序 updates。
- 能力异常不改正常 run 终态，取消/模型失败不执行能力。
- 助手保存失败无未提交事件，预计算变更、锁释放、通知与终态顺序。
- output 禁止伪造/删除，新写拒绝旧 results；正文编辑保留结果，旧 output 只读归一化保留重复路径和 reason，旧 entry 无 output 正常读取。
- 输出侧无历史回填、重复执行、额外调用、配额或表变更；输入侧旁注由独立上下文方案验收。
- 自定义后处理提示词引用 history.summary 时被拒绝，正常上下文保持摘要单次注入。

2026-11-20 输出后处理交付时的验证结果：

| 核验 | 结果 |
| --- | --- |
| `pnpm --filter @sillyrealms/server exec vitest run src/modules src/usecases src/infrastructure src/http src/testing` | 37 个测试文件、434 项测试全部通过 |
| typecheck | 通过，exit 0 |
| lint | 通过，exit 0 |

本方案、任务清单、运行事实文档及两级 AGENTS 已同步。交付要求为按本轮授权提交并推送全部变更，核对远端提交与工作区状态；提交与推送结果以 Git 历史及本轮交付记录为准。
