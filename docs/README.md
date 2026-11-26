# SillyRealms 文档

从一个可玩的世界开始，再逐步设计你自己的角色、玩法和界面。

[返回项目首页](../README.md) · [示例作品](../examples/worlds/README.md) · [创作 Skills](../skills/README.md)

## 我想先体验

[快速体验](getting-started.md)会带你启动 SR、配置模型、导入《雾港来信》并完成第一次互动。首次体验不需要阅读 SDK。

## 我想创作自己的世界

| 任务 | 文档 |
| --- | --- |
| 理解世界、角色、开局、会话和状态的关系 | [创作者入口](creator/README.md) |
| 复制一个模板，做出第一张卡 | [第一张世界卡](creator/first-world.md) |
| 写人物、世界资料与故事入口 | [世界内容](creator/world-content.md) |
| 设计能随剧情变化的数据 | [状态与玩法](creator/state-and-rules.md) |
| 选择叙事方式和模型 | [预设与模型](creator/presets-and-models.md) |
| 设计自己的阅读与交互界面 | [展示与舞台](creator/presentation.md) |
| 检查、打包、交给别人游玩 | [打包与分享](creator/packaging.md) |
| 声明作者与版本，发布可在线更新的作品 | [作者发行指南](creator/world-publishing.md) |
| 排查导入、状态、素材和组件问题 | [常见问题](creator/troubleshooting.md) |

## 我已有酒馆作品

先读[酒馆迁移指南](creator/from-sillytavern.md)，整理原卡中的设定、变量、展示和脚本行为。使用[迁移 Skill](../skills/sr-tavern-migrate/SKILL.md)辅助改编，并核对迁移后的实际体验。

## 我想用 Agent 创作

[Agent 创作指南](creator/agent-authoring.md)包含可直接使用的需求示例、交付要求与迭代方式。两个 Skills 与这些文档、示例和校验工具使用同一套契约。

## 查精确格式与接口

| 需要查阅的内容 | 参考 |
| --- | --- |
| 世界卡字段、必填项、引用关系 | [世界卡格式](reference/world-card.md) |
| 公开版本目录、发行文件与本地覆盖 | [开放 OTA 协议](reference/world-updates.md) |
| 会话、历史、状态、组件和资源 API | [SDK 开发手册](sdk/README.md) |
| 校验 API 与工具使用边界 | [工具参考](sdk/tooling.md) |
| 作者组件的挂载和权限 | [组件契约](design/world-components.md) |
| 平台界面规范 | [UI 规范](design/UI-SPEC.md) |

## 开发、部署与实现

- [本地运行与调试](runtime/local-development.md)
- [Linux 单机部署](../deploy/README.md)
- [HTTP 接口](runtime/server-http.md)与[事件协议](runtime/server-events.md)
- [服务端叙事](runtime/server-narrative.md)与[Web 会话运行](runtime/web-runtime.md)
- [Web 管理](runtime/web-management.md)与[状态实现](runtime/state-v2.md)
- [贡献指南](../CONTRIBUTING.md)

教程说明怎么完成创作；参考资料描述当前契约；[plan](../plan/) 保存提案和阶段性设计。引用计划中的能力前，请先核对实施状态。
