# Runtime 修改约束

- 后置处理插件独立解析、校验和返回结果；禁止将其他插件状态作为行动建议的启用或发布条件。
- 正文正常完成时，插件的 partial / failed 不改变 Run 的 completed 结果。状态快照校验失败只影响状态插件；数据库提交失败仍属于 Run 失败。
- 建议只能在终态提交成功且未取消、正文完整、建议自身 ready 时发布；保留 Host 对当前 Run 和已保存正文消息的核验。
- 后置处理错误文案只允许在服务端 SILLYREALMS_DEBUG=1 时展示，默认关闭，不以开发构建代替 DEBUG。
- 修改此链路时更新 docs/runtime/postprocess.md，并运行 src/runtime/postprocess 下的回归测试、项目类型检查与前端构建。
