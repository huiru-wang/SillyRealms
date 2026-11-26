# SR 世界卡集中发布与 Discord 评论方案

- 日期：2026-11-24
- 状态：可选托管设计，未实施。2026-11-26 明确当前先实现开放作者信息与 OTA 协议，不将统一 Hub 或 Discord 服务列为依赖。
- 仓库：/Users/wanghuiru/Workspace/SillyRealms
- 基础方案：[世界卡作者元信息、版本目录与覆盖更新](world-card-versioning-v1.md)。
- 范围关系：基础方案允许任意来源遵守同一版本目录/文件协议；本方案只描述未来可能运营的一种托管服务。没有该服务也应完整支持检查版本、下载指定版与本地覆盖。以下推荐仅在另行决定建设集中发布服务时适用。

## 1. 推荐结论

由 SR 运营一个轻量的「世界卡发布中心」，统一接收卡包、保存历史发行文件、生成作品页和全版本目录。Discord Forum 承担每个作品的讨论与评论；Discord 应用交互可以作为第二个投稿入口。

创作者只需要选择作品、上传 ZIP、填写版本号和更新说明、确认发布。域名、存储桶、下载链接、SHA-256 和 releases.json 均由平台处理。平台仍需承担存储与服务运营，但每位创作者不需要各自寻找存储服务。

建议组合：

| 责任 | 负责方 |
| --- | --- |
| 创作者身份、作品归属、发布权限 | SR Hub |
| 作品介绍、版本列表、更新说明 | SR Hub |
| 不可变世界卡发行文件 | SR 统一管理的对象存储 |
| 面向本地 SR 的固定版本目录 | SR Hub，保持既定 releases.json 协议 |
| 评论、回复、创作者交流 | Discord Forum，每张卡一个长期帖子 |
| 本地更新红点、选版本覆盖 | 既有本地版本方案 |

网页上传应为第一入口，避免所有创作者必须通过 Discord 的文件上传限制。已有 Discord 社区时，可以随后补 /publish 附件命令，两种入口复用同一套发布逻辑。

## 2. Discord 可以承担哪些能力

### 2.1 可以承担集中展示、投稿入口和评论

Discord 官方 Forum 支持按帖子组织讨论，具有标签、筛选、列表/画廊视图与角色权限；需要开启 Community。适合每张世界卡一个作品帖。帖子不活跃后移入旧帖区域，不应把归档理解为版本文件被删除。[D1]

建议频道组织：

- 世界卡频道：Forum，每张作品一个帖子。
- 首帖：封面、作者署名、简介、作品主页、最新公开版本和更新说明入口。
- 帖内回复：用户评论、作者答疑、新版发布公告。
- 发布权限与回复权限分开设置；评论者不能因此获得世界卡发布权。
- 一次普通版本更新沿用同一个帖子；不要每版都拆成新的作品帖。

### 2.2 附件不是永久直链

Discord 附件 CDN 使用带到期时间的签名 URL。重新通过 API 读取对应消息时，返回的附件地址可以得到有效签名；这不等于此前复制到外部程序的 URL 永久有效。[D2]

因此：

- 不把 Forum 网页地址或消息链接写成 publication.update_url。
- 不把首次拿到的 Discord CDN 附件 URL 永久写进 artifact.url。
- 不以删除签名 query 参数的方式声称获得永久下载地址。
- 不依赖用户每次打开 Discord 帖子来刷新 SR 的下载地址。

真正的问题是外部地址会失效，不是「Discord 根本不能存文件」。

### 2.3 显式投稿可以做，普通 Webhook 不能代替收件服务

Discord Slash Command 支持 ATTACHMENT 参数。可以提供：

~~~text
/发布世界卡 作品:雾港纪事 文件:world.zip 版本:1.3.0 更新说明:新增港口夜巡
~~~

应用获得用户主动提交的附件和交互身份，下载到 SR 临时区，再走正式发布流程。采用显式交互无需为抓取所有聊天内容而申请 Message Content intent。[D3][D4]

普通 incoming webhook 适合从 SR 向 Discord 发通知。Forum 中使用 thread_name 可以建帖，thread_id 可以在既有帖子中发送消息；它不是接收所有用户评论或附件的通用入口。[D5]

公开交互入口需验证 Discord 请求签名，并及时 defer；官方要求首次响应在 3 秒内，交互 token 的后续响应窗口为 15 分钟。耗时任务的可靠发布记录保存在 Hub，不能只保存在短期交互响应中。[D6]

### 2.4 上传限制决定需要网页入口

截至本次查询，Discord 开发文档的默认单文件上传限制为 20 MiB，用户权益及服务器情况可能提高上限；交互提供 attachment_size_limit。实现时使用实际限制，不把历史的 10 MB 或某个会员额度写死。[D2]

世界卡包含图片、音乐等资源时可能超过限制。遇到超限，应提供同一作品的 Hub 上传页；不要求创作者购买会员、不分卷发布、不将多个附件拼成另一套更新协议。

## 3. 三类方案比较

以下“推荐程度”是结合 SR 当前公开 JSON/ZIP 更新协议作出的工程判断。

| 方案 | 创作者是否需要另找存储 | 评论 | 对 SR 自动更新的适配 | 建议 |
| --- | --- | --- | --- | --- |
| 直接发 Discord 帖子和附件 | 不需要 | 帖内讨论现成可用 | 必须额外处理签名 URL、版本索引、身份与权限 | 可用于手动分享，不作为正式更新源 |
| SR Hub + 统一存储 + Discord Forum | 不需要 | Discord 帖内讨论 | 直接生成现有协议 | 推荐的持续运营方案 |
| SR 官方 GitHub Releases + Discussions | 由官方集中托管时不需要 | Discussions | 需为每个作品生成自己的 releases.json | 适合少量官方/精选卡的过渡方案 |
| itch.io 项目页 | 不需要自行托管文件 | 页面评论或讨论板 | 需额外适配其下载/版本接口 | 适合现成作品发布页和手动下载分发 |

GitHub Releases 提供发行说明、附件与发行 API，管理 release 需要仓库写权限；Discussions 提供讨论。不能仅开放一个公共仓库，就让所有用户自然拥有各自作品的独立发版权限。多作品共用仓库仍需由维护者或发布程序处理权限、作品 ID 与 tag 命名。[G1][G2][G3]

itch.io 替创作者托管文件，项目页可启用评论或讨论板。其官方说明网页下载链接会到期，不能把浏览器临时链接直接当永久 artifact.url。[I1][I2][I3] 这不代表 itch 没有历史构建能力；只是不能省略与 SR 版本协议的适配。

如果暂时不运营对象存储，可先由 SR 官方集中发布 GitHub Release 附件，再生成各作品的标准目录。创作者仍通过统一投稿流程提交，不要求每人维护仓库。不要让本地客户端依赖 GitHub 仓库级 latest 来判断某张世界卡的版本。

## 4. 推荐架构与边界

~~~mermaid
flowchart TD
    A["创作者"] -->|"上传卡包与说明"| H["SR 发布中心"]
    H -->|"保存发行包"| S["统一文件存储"]
    H -->|"作品帖与版本公告"| D["Discord Forum"]
    P["本地 SR"] -->|"启动或主动刷新版本目录"| H
    P -->|"下载选定版本"| S
    P -->|"用户打开讨论入口"| D
~~~

SR Hub 是运营方部署的一套公共服务。本地 SR 继续管理玩家自己的世界、会话、运行状态、模型配置；不把这些数据上传 Hub，也不让每个本地实例运行自己的发布平台。

Hub 最小部署可以采用一个服务、一份关系数据库、一个对象存储。数据库保存小型发布元数据，ZIP 放文件存储。具体服务商按部署条件选择，不引入多供应商抽象。

对象存储可采用 R2 或同类 S3 兼容产品。R2 官方支持临时签名上传、服务端上传和自定义域名公开分发。[S1][S2] 这些只是可选实现能力，预算以实际存储量、下载量和请求量计算，本方案不承诺免费托管。

需要区分两种地址：

- 上传地址可以短期有效，授权本次上传到私有暂存区。
- 版本目录内的下载地址必须稳定、公开，始终对应同一份已发布字节。

上传只能写草稿/暂存对象。创作者拿到的上传权限不能直接覆盖 published 文件。大文件可按实际需求选择直传；第一版可以采用受限服务端上传，避免预先建设复杂分片框架。

## 5. 创作者实际操作

### 5.1 首次发布新作品

1. 登录发布中心。可使用 Discord OAuth 建立账号；登录只确认账号身份，作品归属仍由 Hub 自己管理。
2. 点击「发布世界卡」，上传符合当前 SR 格式的 ZIP。
3. 平台读取作品名称、简介和署名，作者填写版本号、版本标题和更新说明。
4. 新作品分配一次 package_id，并生成固定作品页、版本目录和讨论入口地址。
5. 在草稿阶段将这些正式 publication 写入待发布包；展示规范化后的元信息供作者确认。
6. 校验、生成最终 ZIP、计算最终 SHA-256 和大小，保存文件。
7. 发布版本记录，公开目录可见。
8. 创建作品讨论帖或显示讨论入口的准备状态，返回可分享的作品页与正式 ZIP。

Hub 保存的正式 ZIP 可以与作者最初上传的草稿 ZIP 不同，因为草稿尚未完成发行元信息。必须明确展示和返回最终产物；已发布后的包不再改写。

下一次发版通过「我的作品 → 发布新版本」，沿用同一 package_id 和链接。若作者继续在本地创作，可以下载平台生成的 publication 片段或发行包，合并回创作源。

### 5.2 发布已有作品的新版本

1. 从自己的作品列表选择作品；不按文件名或昵称自动授权。
2. 上传新包、填写新版本号和说明。
3. 平台检查当前账号是否拥有该作品发布权，以及包内 ID 是否与所选作品一致。
4. 已有正式版本的作者提交 ID 不匹配时拒绝，不静默改成另一个作品。
5. 校验成功后发布，更新原讨论帖中的最新版链接并追加发版公告。

版本号遵守基础方案的稳定 MAJOR.MINOR.PATCH。对同一个 package_id + version，正式包不可换字节。再次上传同版不同哈希应报版本冲突；同一次发布请求的重试按幂等键返回既有结果。

### 5.3 已有外部发行作品迁入 Hub

package_id 已存在的作品迁入 Hub，需要单独验证归属；不能凭 UUID、包内 authors 或上传了 ZIP 就认定拥有发布权。可采用原发布源放置一次性验证标记、原所有者授权或维护者人工核验。

正式旧版如果需要镜像到 Hub，应保留原字节与原哈希；不能为了补 homepage 或 discussion_url 重新打包同一已发布版本。新的元信息在下一正式版本引入。

基础方案覆盖时保留当前绑定的 update_url。因此：

- 已安装的外部卡不会因为下一版 ZIP 填了 Hub URL，就自动切换订阅来源。
- 迁移期可继续维护旧目录，或让旧目录公开重定向到 Hub 的目录；遵守原有 HTTPS、重定向和大小限制。
- 旧域名完全失效时，需要后续单独设计显式来源迁移；不能把它伪装成普通覆盖更新。
- 回退旧版时继续保留本地当前绑定的更新源。

## 6. publication 与版本目录如何衔接

基础结构保持不变。可增加一个可选 discussion_url，让世界详情直接显示「讨论」入口；若第一版只通过作品主页进入讨论，homepage 本身已足够。

以下展示世界卡 data.publication 的对象值；类型统一为 WorldPublication，数据库列为 publication_json。它只保存创作者声明的作品发行信息；本地 OTA 检查状态与版本目录不写入该对象。域名仅为示例，不是已部署地址。

~~~json
{
  "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
  "authors": [
    {
      "name": "雾灯",
      "url": "https://hub.example.org/creators/fog-lamp"
    }
  ],
  "release": {
    "version": "1.3.0",
    "published_at": "2026-11-24T22:00:00+08:00",
    "notes": "新增港口夜巡，修正两处角色设定。"
  },
  "homepage": "https://hub.example.org/worlds/8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
  "update_url": "https://hub.example.org/worlds/8da0e392-2ea6-4ac1-a93a-b94abf6828a1/releases.json",
  "discussion_url": "https://hub.example.org/worlds/8da0e392-2ea6-4ac1-a93a-b94abf6828a1/discussion"
}
~~~

discussion_url 是面向人的 HTTP(S) 地址，页面可要求 Discord 登录或加入服务器。它没有“匿名返回 JSON”的要求。校验与 homepage 同类，拒绝 javascript:/data: 等协议；Hub 生成 HTTPS 地址。

Hub 的 /discussion 根据自己的作品映射跳到实际论坛帖；没有帖子或帖子失效时显示提示页。今后替换帖子、迁移论坛，不必改旧卡包。不要设计接受任意外部 URL 参数的开放跳转。

update_url 继续匿名返回基础方案的完整 WorldVersionIndex：

- schema_version = 1。
- package_id 与卡包一致。
- versions 中每条包含 version、title、published_at、notes、spec_version、artifact。
- artifact 包含 format、url、sha256、size_bytes。
- 不增加由创作者手填的 latest；本地按合法版本号求最大值。
- 不返回草稿、尚未校验的包或未公开发行。
- 遵守原首版目录大小与版本条数限制，不静默分页或截断“全版本目录”。

例如具体版本的 artifact.url：

~~~text
https://downloads.example.org/worlds/8da0e392-2ea6-4ac1-a93a-b94abf6828a1/1.3.0/world.zip
~~~

可在对象 key 内再加入 hash。无论 URL 形式如何，同一公开版本地址始终对应相同字节，不在下载时注入最新作者资料或评论地址，不重打 ZIP。

版本目录建议设置 Cache-Control: no-cache 并提供 ETag，避免启动检查或用户主动刷新仍长期命中旧目录。不可变版本包可采用长缓存和基于哈希的 ETag。目录 HTTP 缓存策略不增加本地版本检查的触发次数。

## 7. 评论怎样呈现

### 7.1 推荐首版：Discord 评论，SR 提供明确入口

SR 世界详情作者/版本区域增加「作品主页」「讨论」入口。Hub 作品页也显示同一入口，点击进入该卡的 Discord Forum 帖子。

- 作品帖固定对应 package_id，不对应本地 worldId。
- 全部发行版共享作品评论；版本公告在回复中标注版本号。
- 可以约定反馈时注明安装版本，但普通 Discord 回复不视为结构化的版本评分。
- 作品首帖由平台维护，展示公开页面及当前最大已发布版本。
- 评论是否可读、可回复由 Discord 社区权限控制。
- Hub 不保存评论副本，不伪造站内评论数量，也不声称能在 SR 内直接回复。

这满足“作品有评论区”，但不等于“评论内容直接嵌在 SR 详情页”。

### 7.2 如果需要 SR 页面内阅读和回复

后续单独提供 Hub 原生评论，最小可以只有作品 ID、可选目标版本、作者账号、正文、回复关系、时间与删除状态。评论权限和用户屏蔽/处理能力跟随此功能一起设计。

不建议同时维护 Discord 与 SR 两套评论的双向同步。消息编辑、删除、引用、身份和权限难以自然对应；应选择一个主评论系统，另一个保留入口或公告。

本期不承诺 iframe 嵌入 Discord 帖子即可获得可用评论区，不加入抓取普通频道历史的旁路。

## 8. Hub 最少保存哪些数据

以下是新公共发布服务的数据，不是本地 SR 数据库迁移。本地 worlds 只新增 publication_json；拉取到的公开版本原始 JSON 保存在 dataRoot/worlds/<worldId>/releases.json，与 source/package 同级。最新版从文件内容计算，检查状态只留在内存；Hub 接入不改变这套本地布局。

| 数据 | 必要信息 |
| --- | --- |
| 创作者账号 | 内部账号 ID、登录提供方及稳定用户 ID、展示资料 |
| 作品 | package_id、所有者账号 ID、名称/简介/封面、可见状态、讨论映射 |
| 发行版 | package_id、version、标题/说明/时间、spec_version、文件 key/URL/hash/大小、发布状态 |
| 发布过程 | 幂等请求 ID、提交者、暂存/验证/发布结果；可复用发行草稿记录 |
| 社区通知 | 对应作品/版本、发送状态、已取得的消息 ID；可放作品/发行记录扩展中 |

第一版一个所有者足够；多人协作待实际需求出现再扩展。账号归属与 authors 展示署名分开，不把 Discord 昵称、Webhook username 或包内署名作为权限依据。

数据库设置 package_id + version 唯一约束。写权限只在发布服务，公开目录和已发布文件匿名可读；密钥与 Webhook token 不进入世界卡、版本 JSON、Web 前端或本地玩家配置。

## 9. 发布顺序、失败与撤回

发布按以下顺序进行：

1. 验证登录、作品归属和请求幂等性。
2. 将附件存入受控暂存区，校验 ZIP 路径、大小、结构与世界卡格式。
3. 草稿阶段确定所有正式元信息，生成最终发行包。
4. 对最终字节计算 hash 和 size，校验包内 package_id/version/spec_version 与发行记录一致；将最终 publication、文件 key、hash 和 size 固定保存到发行草稿。
5. 将最终文件保存到独立、不可覆盖的发行位置，确认可完整读取。
6. 用短数据库事务基于当前已发布记录检查「加入候选版本后的完整目录」的条数与序列化字节数，满足基础协议限制后原子发布发行记录；目录从已发布记录生成。文件与网络操作均在事务外。
7. 独立发送或更新 Discord 作品帖与版本公告。

上传校验复用项目现有 world:check / world:pack 规则，不复制另一套卡片语义，也不在 Hub 内执行作者组件。具体纯校验代码如何共享在实现前确认，避免跨服务直接访问本地世界数据库。

关键处理：

- 文件保存失败：不发布目录条目。
- 文件保存成功但发布事务提交失败：保留草稿与其最终文件供重试，目录仍不可见；不要把半成品标为发布成功。只有明确放弃或超过草稿保留期、且未被任何正式发行引用的对象，才进入清理。
- 发布重试：已经有正式记录时，返回既有发行结果。若文件已保存但发布事务未提交，则复用草稿中固定的 publication、文件 key、hash 和 size，继续提交同一份最终文件；不重新取发布时间、不重新打包，也不假称已有正式版本。
- Discord 发帖失败：版本仍然发布成功，单独显示社区通知失败；不回滚已经可下载的世界卡。
- 已确认发送的消息保存 ID 后重试编辑；网络超时导致发送结果不确定时先查询/核对，避免盲目反复建帖。评论通知只承诺可恢复处理，不承诺跨 Discord 与数据库精确一次事务。
- 发布完成后可修改目录中的说明文案，但不能因此重写 ZIP；改包内说明也需要新版本。说明修改也必须验证候选完整目录大小；超出条数/大小预算时拒绝本次发布或文案修改，不公开一个本地客户端会整份拒绝的目录。
- 下架发行时从公开目录移除，并按运营决策保留或阻断文件。当前基础协议没有“撤回即通知已安装用户”的保证。
- 本地版本缓存尚未刷新时，用户可能还看到已撤回版本；应用遇到文件不可用应明确失败，不覆盖本地内容。

Hub 的讨论变更、评论变更和公告不会驱动本地客户端额外检查版本。

## 10. 与本地更新方案的完整关系

| 既定行为 | 接入 Hub 后 |
| --- | --- |
| 服务启动后异步检查一轮 | 保持，只是 update_url 通常由 Hub 托管 |
| 世界列表读取本地 publication 与 releases.json | 保持，版本目录从对应世界根目录读取，不访问 Discord 或 Hub |
| 前端对比 currentVersion/latestVersion | 保持，落后显示红点 |
| 世界详情读取本地版本列表 | 保持，读取根部 releases.json，不因打开详情补查 |
| 详情主动刷新按钮 | 保持，用户点击后获取原始 JSON，校验后原子替换 releases.json 并同步红点 |
| 选指定版本下载并覆盖 | 保持，从稳定发行地址取包并校验 |
| 回退保留当前 update_url | 保持，同时保留根部 releases.json 及其 mtime |
| 保留聊天、运行状态和管理配置 | 保持 |
| 运行中的客户端马上收到新版本 | 不主动推送；用户可手动刷新，或等下次服务启动检查 |
| 新导入卡取得远端版本列表 | 不自动补查；用户可立即在详情点击获取，无需重启 |
| 作品评论 | 新增人类可点击的讨论入口 |

本地 OTA 流程统一复用基础方案的 usecases/world-updates/：启动检查、主动刷新、只读版本投影与应用版本共享同一实例，经 WorldService 读写世界目录；不因来源是 Hub 再创建一套客户端用例、缓存或任务状态。Hub 仍只提供统一的公开目录与文件协议。

玩家无需 Discord 账号即可通过公开 Hub 目录检查更新和下载公开发行。若要参与 Discord 评论，遵守社区登录/加入要求。发布中心的作者登录不改变玩家匿名下载协议。

Hub 网站本身可以展示实时的公开发行列表；这不改变本地安装详情读取缓存的规则。两处界面应标清“线上作品页”和“本地安装”。

首次获取可以先采用作品页下载 ZIP、导入 SR 的已有流程。无需为了集中托管同时追加整个站内商城、推荐系统或在线安装框架。

## 11. 如果坚持文件全部放 Discord

技术上可以做兼容网关：

1. 保存作品、版本、Discord 消息 ID、附件 ID 和发布时 hash。
2. 对本地 SR 暴露稳定公开 releases.json。
3. artifact.url 指向网关的稳定下载接口，而不是临时 Discord 附件地址。
4. 网关收到文件请求后，以服务器侧权限重新读取消息，获得有效附件 URL。
5. 获取原始附件并验证预期 hash，再交付相同发行字节。

这种方式可以兼容“本地启动自动检查一轮并允许用户主动刷新”：文件请求时解析附件属于下载执行，不是再次刷新版本目录。

但它仍需要后台服务、持久发布记录、Discord 权限和流量处理；不是零后端方案。普通用户消息附件还可能涉及 Message Content 能力限制，采用平台自己的发布消息也必须维护消息可访问性。[D2][D4]

原消息删除、附件替换、权限变更或服务不可访问都可能使历史版本失去来源。即使把消息 ID 保存下来，也不能恢复已经不可取的原文件。若持续保留附件副本，又回到了自己管理文件存储。

因此可用于小规模实验，正式版本分发仍推荐收到投稿后立即保存到 SR 管理的存储。评论贴删除不应连带删除正式发行包。

## 12. 建议实施顺序

### 阶段 A：完成基础本地版本能力

按基础方案实现 data.publication / publication_json、世界根目录 releases.json，以及 usecases/world-updates/ 内统一的启动检查、用户主动刷新、版本投影和指定版本覆盖。版本文件保存校验通过的远端原始 JSON，磁盘操作复用 WorldService；检查失败保留旧文件，状态只留在同一用例实例内存。集中发布与自托管遵循同一种公开协议。

### 阶段 B：最小可用的集中发布

实现作者登录、作品归属、上传与校验、不可变发行存储、作品页、完整版本目录、Discord 讨论入口及发布公告。

先让所有创作者通过同一个网页投稿。评论使用 Discord，Hub 不建自己的评论表。普通 incoming webhook 可满足平台发公告，是否需要应用机器人取决于投稿与后续管理能力。

### 阶段 C：需要时加入 Discord 投稿

增加 /发布世界卡 交互，把显式提交的附件送入阶段 B 的发布流水线。小包在 Discord 内完成，大包链接到 Hub 上传页。

网页与 Discord 投稿只是入口差异，不生成两套作品身份、两套版本号或两套可变包文件。

### 后续按实际需求再做

SR 原生评论、社区发现/推荐、合作作者、私有或付费作品、显式来源迁移分别评估。它们不作为集中托管的前置条件，也不隐式混入本期；用户手动刷新版本列表已属于基础本地版本能力。

## 13. 计划文件改动范围

以下为推荐实施范围，不代表已创建业务模块。集中发布服务建议独立为 apps/hub；本地服务保持运行时职责。下表是 Hub 阶段的增量范围，本地 world-updates 目录、装配及存储边界完整沿用基础方案第 14 节。具体框架与部署方式在实施时按运营环境确定。

~~~text
/Users/wanghuiru/Workspace/SillyRealms/
├── apps/hub/                                      [新增] 独立公共发布服务
│   ├── package.json / tsconfig.json                [新增] 服务依赖及构建
│   └── src/
│       ├── server.ts                              [新增] HTTP、依赖装配及关闭
│       ├── routes/
│       │   ├── auth.ts                            [新增] 创作者登录
│       │   ├── worlds.ts                          [新增] 作品页、目录、讨论跳转
│       │   └── publishing.ts                      [新增] 上传和发布入口
│       ├── modules/
│       │   ├── creators/                          [新增] 账号与发布权限
│       │   └── publications/                      [新增] 作品、发行记录和目录规则
│       ├── usecases/publish-version.ts            [新增] 验证、文件、DB发布编排
│       ├── infrastructure/
│       │   ├── database/                          [新增] Hub自己的元数据表
│       │   ├── storage.ts                         [新增] 选定存储的暂存和发行读写
│       │   └── discord.ts                         [新增] 作品帖及版本公告适配
│       └── pages/                                [新增] 投稿、我的作品、公开作品页
├── apps/server/src/modules/worlds/
│   ├── types.ts / validation.ts                   [修改] publication 的可选 discussion_url
│   └── parser.ts                                 [修改] 讨论链接随 publication 导入导出
├── apps/web/src/features/worlds/
│   ├── api/worlds.ts                              [修改] 透传可选讨论链接
│   └── WorldDetailPage.tsx                        [修改] 作品主页和讨论入口
├── apps/web/src/i18n/locales/                     [修改] 沿用中英日文案体系
├── scripts/world-card.mts                        [按需修改] 复用现有校验/打包入口
├── docs/
│   ├── reference/world-card.md                    [修改] 可选讨论链接契约
│   └── creator/world-publishing.md                [新增或扩展] 托管发布操作说明
└── plan/
    ├── world-card-versioning-v1.md                 [修改] 补充方案链接
    └── world-card-publishing-hub.md                [新增] 本方案
~~~

删除文件：无。阶段 C 再在 Hub 增加 Discord interaction 路由与命令处理，不先建设监听全部聊天的服务。Hub 新模块沿用路由、用例、服务、仓储的职责边界；数据库事务不包网络上传或 Discord 调用。

本轮实际修改范围仅为 plan 中的两份文档。已有本地版本方案的其他业务文件仍是待实施范围。

## 14. 关键验收

1. 普通创作者只上传 ZIP 和填写说明，即可获得作品页、版本目录、发行地址，无需配置对象存储。
2. 两个账号上传相同 package_id，未授权账号不能给已有作品发版。
3. 同版不同包被拒绝；发布请求重试不会产生第二个版本或重打旧包。
4. 版本记录公开前，最终文件已存在且 hash/大小可核对。
5. 目录内不存在 Discord 临时附件签名地址；公开版本无需玩家凭据即可下载。
6. Discord 投稿成功后删除原始投稿消息，不影响已保存的正式包。
7. Discord 通知失败不回滚正式发行，作品页显示准确状态。
8. 更换讨论帖只调整 Hub 映射，不改已发布 ZIP。
9. Hub 发布新版时，已运行的本地 SR 不自动补查；用户主动刷新或下次启动检查后正常显示红点。
10. 本地列表和版本弹窗不读取 Discord，评论按钮也不影响安装版本或检查缓存。
11. 迁移旧更新源不能靠新版 ZIP 静默切换；降级不回退绑定来源。
12. 大包超出 Discord 限制时，可以改走同一作品的网页上传入口。
13. 作品下架/发行不可用时，本地下载明确失败并保留当前世界内容。
14. 第一阶段的评论入口能到达正确作品帖，但界面不暗示已实现 SR 内嵌评论。
15. Hub 生成的卡包、作者下载片段及本地导入导出统一使用 data.publication；本地检查与应用仍走同一 worldUpdates 实例，不出现 Hub 专属检查状态或第二套世界文件写入路径。

## 15. 官方资料与核实范围

以下来源核实于 2026-11-24。平台能力来自官方文档；SR Hub 架构、数据模型与实施阶段为本方案建议，并非现有 SR 功能。

[D1]: https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ
[D2]: https://docs.discord.com/developers/reference#signed-attachment-cdn-urls
[D3]: https://docs.discord.com/developers/interactions/application-commands
[D4]: https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent
[D5]: https://docs.discord.com/developers/resources/webhook
[D6]: https://docs.discord.com/developers/interactions/receiving-and-responding
[G1]: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
[G2]: https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/about-discussions
[G3]: https://docs.github.com/en/rest/releases/releases
[I1]: https://itch.io/docs/creators/faq
[I2]: https://itch.io/docs/creators/interact
[I3]: https://itch.io/docs/butler/installing.html
[S1]: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
[S2]: https://developers.cloudflare.com/r2/buckets/public-buckets/

- [Discord Forum：帖子、标签、权限与归档][D1]
- [Discord API：附件签名 URL 与文件上传限制][D2]
- [Discord 应用命令：附件参数][D3]
- [Discord Message Content 的交互替代方式][D4]
- [Discord Webhook：论坛建帖与回复][D5]
- [Discord 交互接收、签名和响应窗口][D6]
- [GitHub Releases][G1]、[Discussions][G2]、[发布 API][G3]
- [itch.io 创作者托管][I1]、[评论与社区][I2]、[下载链接到期说明][I3]
- [R2 临时签名上传][S1]、[自定义域名公开分发][S2]
