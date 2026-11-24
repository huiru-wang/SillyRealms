# SR 创作 Skills

这些 Skill 服务于当前仓库中的世界卡创作。将完整仓库交给能读写本地文件的 Agent，并明确要求读取对应 SKILL.md；不需要安装全局 Skill，也不要求 AgentDock 或某个客户端的私有环境。

| Skill | 何时使用 | 主要交付 |
| --- | --- | --- |
| [sr-world-author](sr-world-author/SKILL.md) | 从想法新建世界，或修改已有 SR 作品的内容、状态、组件 | 源文件、JSON / ZIP、真实检查结果、试玩步骤 |
| [sr-tavern-migrate](sr-tavern-migrate/SKILL.md) | 迁移酒馆角色卡、世界书、变量与交互行为 | 行为映射、SR 作品、非等价项与验收记录 |

示例请求：

~~~text
请阅读 skills/sr-world-author/SKILL.md，
基于 examples/worlds/minimal 制作一张港口探索世界卡，
保留官方正文界面，增加金币和已知线索，交付可导入 ZIP。
~~~

Skill 只描述工作流程和按需阅读入口。字段规范在 [docs/reference/world-card.md](../docs/reference/world-card.md)，面向人的教程在 [docs/creator](../docs/creator/README.md)，API 在 [docs/sdk](../docs/sdk/README.md)，校验器复用实际导入契约，不在 Skill 中另造一份协议。

不同 Agent 对自动发现 skills/ 的支持不同；如果未自动选择，直接让它读取上述文件。仅下载单份 SKILL.md 不包含所需示例和工具。完整使用方式、修改与迁移请求见[使用 Agent 创作](../docs/creator/agent-authoring.md)。
