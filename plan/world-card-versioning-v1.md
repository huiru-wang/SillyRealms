# SR 世界卡作者信息与开放 OTA 协议 v1

- 初稿日期：2026-11-24
- 最近修订：2026-11-26
- 状态：已实施（2026-11-26）。以下为当前协议、产品行为与验收边界；验证记录见第 15 节。
- 仓库：/Users/wanghuiru/Workspace/SillyRealms
- 适用代码：当前 apps/server、apps/web、packages/sr-sdk。
- 本版按最新需求采用「同一世界原地覆盖指定版本」。不采用上一轮建议的多版本安装或 world_packages 分组。
- 更新源不绑定统一域名、账号、平台或 provider；发布者可自行实现同一协议。
- 正式作品发行信息统一使用 data.publication / WorldPublication / publication_json；只承载创作者声明且随卡分发的信息。
- OTA 的读取、启动检查、手动刷新、下载与应用编排统一归 usecases/world-updates/；世界卡持久化继续由 WorldService 管理。
- [集中发布与 Discord 评论方案](world-card-publishing-hub.md)仅为未来可选的托管实现，不是 OTA 标准依赖，也不是当前实施前置。

## 0. 开放协议边界

本方案定义 SR World Update Protocol v1。这里的“标准”指 SR 对创作者、托管方与客户端公开的稳定契约；不是声称 CCv3 已定义同名作者结构或 OTA。

| 能力 | 执行方与契约 |
| --- | --- |
| 描述作者与当前发行版 | 世界卡 `data.publication`，随卡包导入、导出 |
| 获取全部公开版本 | SR 服务端 `GET publication.update_url`，读取一份完整版本目录 |
| 获取指定版本世界卡文件 | 按明确的 `version` 选择目录记录，再 `GET artifact.url`，返回该版原始完整文件 |
| 应用指定版本 | 本地 SR `POST /api/v1/worlds/:id/apply-version`，校验后原地覆盖 |
| 获取本地已知版本信息 | 本地 SR `GET /api/v1/worlds/:id/versions`，仅返回缓存 |
| 主动刷新版本目录 | 本地 SR `POST /api/v1/worlds/:id/versions/refresh`，读取远端，校验后保存到该世界目录的 releases.json |

远端只需要提供 JSON 和文件；它可以是静态站点、对象存储或动态服务。协议不规定 URL 路径模板，也不要求安装 SR 服务端、提供平台账号或实现上述本地 API。版本目录和世界卡文件可以来自不同域名，客户端不按托管商名称分支处理。

OTA 在本期的产品行为是“检查可用版本、提示更新、由用户选择目标版本应用”。远端发布新版本不会主动改写玩家安装。检查触发采用“每次服务启动自动一轮 + 用户在详情主动刷新单卡”；协议本身不绑定检查频率。

## 1. 已确定的产品范围

1. 世界卡正式增加 data.publication，记录作品身份、作者、当前发行版与更新源。
2. 创作者提供一个固定 HTTPS 地址，返回该作品的完整公开版本目录。
3. 每个版本是一条数据对象，包含版本号、更新说明、发布时间和可直接下载的世界卡文件。
4. 每次服务启动，在完成本地初始化并开始监听后，后台异步执行一轮版本目录检查；世界卡详情另提供用户主动刷新入口。
5. 世界列表、详情和版本列表 GET 接口只读取本地数据与检查缓存；仅启动批次或显式刷新 POST 会触发远端目录请求。
6. 在对应世界目录保存最近一次成功获取的完整公开版本原始 JSON；最新版从文件内容计算，前端与当前版比较后显示一个红点。
7. 世界详情可以查看作者目录中所有公开版本，选择其中一个覆盖当前世界，包括升级和回退。
8. 覆盖保留本地 worldId、已有会话、历史消息、运行状态及本地管理配置；后续叙事与舞台使用覆盖后的作者内容。
9. 本期不增加定时检查、每次列表请求检查、详情打开补查、社区后台、增量下载、长期本地版本仓库或自动状态迁移。

「所有版本」指作者在目录中列出且仍公开提供的版本，并不保证找回作者已移除的历史发行。平台只保留一份当前安装，历史版在用户选中时重新下载。

### 1.1 自动检查与用户主动刷新的边界

- 新导入的世界卡不自动补查；有 update_url 时，用户可立即在详情点击「获取版本列表」，无需等到下次服务启动。
- 首屏早于后台检查完成时，读取上次缓存；从未检查过则显示未知。
- 启动后台更新 releases.json 不新增全局推送，其他已打开页面在下一次正常读取时获得结果。
- 用户主动刷新完成后，发起操作的客户端立即同步版本列表、详情及世界列表摘要，重新计算红点，不要求退出页面再进入。
- 详情打开、版本弹窗打开、切换 Tab 和普通页面刷新都只读取本地缓存；显式版本刷新按钮才发起远端获取。
- 没有缓存时显示「尚未获取版本列表」及获取按钮；已有缓存时可查看最后成功时间并手动刷新。
- 用户主动应用某个版本只下载所选发行文件，与刷新版本目录是两个独立操作。

首版触发只有启动自动一轮和用户主动刷新。继续不增加导入后自动补查、TTL 自动过期重拉、定时器、轮询或任务队列。

## 2. 实施前代码依据

| 实施前现状 | 源码位置 |
| --- | --- |
| 示例中仅有自由扩展 authoring.author / revision / notes | docs/world-card.json |
| 正式世界卡字段没有 publication | apps/server/src/modules/worlds/validation.ts、types.ts |
| 作者扩展可以随导入/导出传递，但没有发布语义 | apps/server/src/modules/worlds/parser.ts |
| 普通导入创建新 UUID，并套用应用默认预设与模型 | apps/server/src/modules/worlds/service.ts、usecases/import-world.ts |
| 文件位于 dataRoot/worlds/<worldId>/source 与 package | apps/server/src/modules/worlds/files.ts |
| 现有发布函数拒绝覆盖已存在目标目录 | modules/worlds/files.ts 的 publishImport |
| 会话只保存 worldId，每轮读取当前世界定义 | modules/sessions/types.ts、usecases/context/capture.ts |
| global/session/message 状态分别存于 worlds/sessions/entries | infrastructure/database/connection.ts、modules/state/service.ts |
| 当前 RuntimeCache 管理叙事与 AI 帮答准入，缺少世界覆盖占用 | infrastructure/cache/index.ts |
| 预览内容身份只看 worldId 和 components 声明 | apps/web/src/features/worlds/preview-cache.ts |
| 资源基地址不允许 query，资源响应缺少明确再验证规则 | packages/sr-sdk/src/asset-url.ts、apps/server/src/routes/worlds.ts |
| initialize 完成后才开始监听，适合监听后启动异步检查 | apps/server/src/server.ts、usecases/initialize.ts |
| narrative / reply-assist 已按应用实例装配，并有统一 shutdown | apps/server/src/usecases.ts、app.ts、usecases/narrative/index.ts、usecases/reply-assist/index.ts |
| usecase 访问模块只能经 service.ts，模块不得反向依赖 usecase | apps/server/eslint.config.mjs |

上述表格记录实施基线。2026-11-26 已加入世界卡 0.2 publication、版本目录、指定版本应用与 DB v11→v12 的 publication_json 迁移；旧 0.1 卡仍兼容，普通导入继续创建新世界并拒绝覆盖。OTA 使用独立的受控替换路径，迁移保留现有数据。

## 3. 世界卡 publication 结构

### 3.1 采用的结构

publication 表示“作品发行信息”，类型名为 WorldPublication。它只保存创作者声明、随世界卡分发的作品身份、署名、说明、当前发行版与公开更新入口；本地安装记录、检查状态、远端目录缓存、用户配置与运行状态不进入这个对象。

release 仅指其中的当前发行版，publication 描述整个作品的对外发行信息。字段按明确 schema 校验，不作为任意键值集合。正式能力尚未实施，首次落地直接使用此命名，不增加旧规划名称的兼容字段或双写。

以下仅展示新增 publication 和所在位置；角色、开局、状态、组件等现有字段沿用原协议。

```json
{
  "spec_version": "0.2",
  "data": {
    "name": "雾港纪事",
    "publication": {
      "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
      "authors": [
        {
          "name": "雾灯",
          "url": "https://creator.example.org/"
        }
      ],
      "creator_notes": "港口题材的多人叙事世界。建议先阅读开局说明，素材致谢见作品主页。",
      "release": {
        "version": "1.2.0",
        "published_at": "2026-11-10T12:00:00+08:00",
        "notes": "新增庄园地图，补充港口角色，优化开局介绍。"
      },
      "homepage": "https://creator.example.org/fog-harbor/",
      "update_url": "https://cdn.example.org/worlds/fog-harbor/releases.json"
    }
  }
}
```

### 3.2 字段契约

| 字段 | 类型 | 要求与含义 |
| --- | --- | --- |
| package_id | string | 正式新卡必填，规范 UUID；首次创作生成并保存，后续发版、改名、回退保持不变 |
| authors | array | 至少一位作者，按数组顺序署名；每项 name 为非空字符串，url 为可选 HTTP(S) 公开主页 |
| creator_notes | string | 可省略，缺省视为空字符串；面向玩家的作者说明、玩法建议与致谢，不是本版更新日志 |
| release.version | string | 正式新卡必填，稳定发行版本 MAJOR.MINOR.PATCH |
| release.published_at | string | 新发行必填，带时区的 ISO 8601 时间 |
| release.notes | string | 本版更新说明，可为空字符串；纯文本或受限 Markdown |
| homepage | string | 可选 HTTP(S) 地址，面向人的作品页面 |
| update_url | string | 可选，面向程序的固定公开 HTTPS 版本目录地址 |

- package_id 是作者作品身份，不能替代本机数据库 world.id；同作品可被用户独立导入多次。
- 作者署名不代表账号认证；不能凭作者昵称或作品名自动关联安装。
- authors[].url 和 homepage 只允许 HTTP(S)，拒绝 javascript:/data: 等协议；更新源和发行文件另按更严格的公开 HTTPS 规则校验。
- 二次创作成为独立发行作品时使用新的 package_id，可在说明中保留原作出处。
- creator_notes 描述作品的整体使用说明；release.notes 只描述本次发行变化，两者独立展示。
- release 只描述当前卡包的发行版；完整历史放在远端版本目录。
- publication 不参与叙事提示词构建；本地更新检查结果不写入 publication。
- 不增加 artifacts 到 publication，避免将 ZIP 自身哈希放进被校验的 ZIP 引发自引用。

### 3.3 版本号规则

本期限定稳定版本：

- 接受 0.1.0、1.2.0、1.10.0。
- 不接受 v1.2.0、1.2、01.2.0、第二章、1.2.0-beta、1.2.0+build。
- 三段均为非负安全整数，不允许非零数字带前导零。
- 前后端复用同一个纯比较函数，逐段按整数比较；禁止字符串字典序、发布时间排序或数组位置排序。
- 版本标题可写「港口夜巡」，但不能代替机器可比较的 version。
- package_id + version 对应一个不可变发行文件。改变包内字节应发布新版本。

### 3.4 三类版本各自独立

| 名称 | 管理者 | 用途 |
| --- | --- | --- |
| world.json.spec_version | SR 平台 | 卡片格式版本 |
| publication.release.version | 创作者 | 世界内容发行版本 |
| worlds.revision | SR 平台 | 本地管理/覆盖写入的 CAS 修订号 |

publication 扩展随卡协议 0.2 发布。继续导入 0.1 卡，缺少 publication 时作为未声明发行信息的离线卡。保留旧 extensions 原样，但不把 authoring.revision 猜成正式发行版本，也不按卡名自动补 package_id。

### 3.5 与角色卡标准的关系

作者元信息参考 CCv3 的语义，SR 仍使用自己的世界卡结构，不重复维护一套平铺的 creator/character_version 字段。

| CCv3 语义 | SR 对应 |
| --- | --- |
| creator：创作者署名 | publication.authors；可表达多位作者 |
| creator_notes：作者说明 | publication.creator_notes |
| character_version：作品发行版本 | publication.release.version；SR 首版增加可比较的数字三段约束 |
| source：来源 | 作为溯源信息参考；不能未经验证就当作 update_url |
| extensions：应用扩展 | SR 原有 extensions 保留其自定义用途，正式发行信息进入 publication |

这是一张语义映射表，不承诺已经实现 CCv3 自动迁移。CCv3 的自由文本版本不能静默转换为合法 SR 发行版本；来源网页也不能自动视为机器版本目录。卡片创建/修改时间与发行的 published_at 不是同一概念。

## 4. 创作者提供的全版本目录

### 4.0 远端 HTTP 交互契约

1. **获取版本目录**：对 update_url 发起 HTTPS GET。基础成功响应是 HTTP 200 + 第 4.2 节的原始 JSON 对象；远端不包裹 SR 本地接口的 success/data 结构。
2. **选择指定版本**：按唯一且完全相等的 version 匹配条目。不得把“最新版本下载地址”替代用户选中的历史版本，也不依赖数组顺序。
3. **获取世界卡文件**：对该条目的 artifact.url 发起 HTTPS GET，基础成功响应是 HTTP 200 + 原始 ZIP/JSON 字节；校验值针对这些最终字节。
4. **本地应用**：下载、完整校验后由 SR 执行安装。发布源没有远程执行玩家安装的接口；不需要另加固定路径的“安装”或“指定版本查询”API。

约束：

- 目录协议版本为 schema_version = 1；不支持的版本作为检查失败处理，保留上次成功缓存。
- 全版本目录不分页、不只返回 latest、不静默截断；上限与失败策略见第 6.1 节。
- 客户端可忽略不认识的非必需字段；新增字段不能改变 v1 已有字段含义，破坏性变更需要新的 schema_version。
- 建议目录使用 application/json，ZIP 使用 application/zip，JSON 卡使用 application/json；实际内容仍须校验。
- 非成功 HTTP 响应、HTML 正文或不符合目录结构的对象都属于失败，不能解释为“没有新版”或空版本目录。
- URL 是完整绝对地址，可包含服务商需要的固定查询参数；不依赖临时签名、浏览器会话或供应商专用解析。
- 静态托管和动态 API 返回同一内容契约即可。具体上传、发布权限、评论、账号体系由发布方自行实现。

### 4.1 目录地址

publication.update_url 指向固定的原始 JSON，例如：

https://cdn.example.org/worlds/fog-harbor/releases.json

要求：

- 公网 HTTPS GET 可访问；不依赖登录、Cookie、API Key、验证码或浏览器脚本。
- 返回 JSON 正文，建议 Content-Type: application/json。
- 不提供 HTML 下载介绍页、网盘分享页、GitHub blob 浏览页或短期签名链接作为 update_url。
- 地址跨版本保持不变；发布新版时更新内容。
- 服务端读取该地址，浏览器不直接请求，因此不依赖作者配置浏览器 CORS。
- ZIP 可以位于另一公开 HTTPS 存储源；正常公开重定向可以跟随，但每次跳转均校验目标。

### 4.2 完整目录示例

下例域名、文件大小及 64 位哈希均为格式示例，实际发布时由打包工具生成真实值。

```json
{
  "schema_version": 1,
  "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
  "versions": [
    {
      "version": "1.3.0",
      "title": "港口夜巡",
      "published_at": "2026-11-24T12:00:00+08:00",
      "notes": "## 新增\n- 夜巡开局\n- 两名港口角色\n\n## 修复\n- 背包面板的展示问题",
      "spec_version": "0.2",
      "artifact": {
        "format": "zip",
        "url": "https://cdn.example.org/worlds/fog-harbor/versions/1.3.0/fog-harbor.zip",
        "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        "size_bytes": 12582912
      }
    },
    {
      "version": "1.2.0",
      "title": "庄园地图",
      "published_at": "2026-11-10T12:00:00+08:00",
      "notes": "新增庄园地图，补充港口角色，优化开局介绍。",
      "spec_version": "0.2",
      "artifact": {
        "format": "zip",
        "url": "https://cdn.example.org/worlds/fog-harbor/versions/1.2.0/fog-harbor.zip",
        "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        "size_bytes": 10485760
      }
    },
    {
      "version": "1.1.0",
      "title": "初次公开版本",
      "published_at": "2026-11-01T12:00:00+08:00",
      "notes": "首个公开版本，包含基础角色、开局和舞台。",
      "spec_version": "0.2",
      "artifact": {
        "format": "zip",
        "url": "https://cdn.example.org/worlds/fog-harbor/versions/1.1.0/fog-harbor.zip",
        "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        "size_bytes": 8388608
      }
    }
  ]
}
```

### 4.3 目录字段

| 字段 | 规则 |
| --- | --- |
| schema_version | 固定整数 1，属于版本目录协议 |
| package_id | 必须与本地 publication.package_id 相同 |
| versions | 该作品仍公开的全部发行记录，可为空数组 |
| version | 唯一的稳定发行版本，遵守第 3.3 节 |
| title | 可选的人类可读版本标题 |
| published_at | 带时区 ISO 8601 发布时间；只展示，不用于排序 |
| notes | 更新说明；允许空字符串，前端显示「暂无更新说明」 |
| spec_version | 该发行文件使用的世界卡格式；下载后必须与包内一致 |
| artifact.format | zip 或 json；ZIP 推荐用于含组件/媒体的完整世界包 |
| artifact.url | 指向实际文件的公开 HTTPS 地址 |
| artifact.sha256 | 最终文件原始字节的 64 位小写十六进制 SHA-256 |
| artifact.size_bytes | 最终下载文件的字节数，正安全整数，安装时核对实际值 |

纯 JSON 发行只适用于不依赖包内缺失文件的卡；继续通过现有导入校验，不放宽 sr-asset:// 引用要求。

用于远端覆盖的发行文件必须带正式 publication，本期对应卡协议 0.2。支持普通导入旧 0.1 卡，不代表无发行身份的旧卡可以成为可应用版本；此类条目在详情禁用，不能下载后才尝试猜测作品身份。

目录不是将每个完整 world.json 内联进一个大 JSON，而是每个版本记录元信息并引用具体文件。检查时不下载各版世界包。

### 4.4 latestVersion 如何得到

- 不要求作者另外填写 latest 或 recommended。
- 服务端将通过校验的 versions 按稳定版本降序排列，最大版本即 latestVersion。
- 空 versions 的 latestVersion 为 null，表示当前源暂无公开版本。
- 最新版是否能被当前 SR 安装，与「有没有新版」分开：仍展示真实 latestVersion；不支持的 spec_version 在详情禁用安装并说明原因。
- 本期不引入测试版/稳定版通道或「作者推荐旧版」语义。

### 4.5 索引一致性

- 任意记录结构错误、重复版本或 package_id 不匹配时，整份目录拒绝，不使用部分目录推导「最新」。
- 同一绑定来源下，新目录与上次成功目录的相同 version 若 sha256 变化，判定发行内容冲突，保留旧缓存。
- 可更新发行说明文字，或将同一哈希文件迁到新的公开下载地址；不能替换同版本文件内容。
- 同版本内容重写检测只能覆盖平台已有的缓存记录，不声称建立了全网永久发行审计。
- 下载时以 sha256 约束实际文件，不把哈希当成作者身份认证。

## 5. 本地存储：publication 入库，公开版本原始 JSON 随世界保存

数据库只为 worlds 新增 publication_json，沿用现有 TEXT 序列化 JSON 的方式，保存当前安装的正式作者/发行 publication；旧卡允许 NULL。通过迁移保留原有世界、会话及运行状态。

公开版本目录不进入数据库；不另存 latest_version、checked_at、has_update 等镜像列，不新增版本表、缓存表或通用任务表。

### 5.1 文件位置与内容

使用现有 dataRoot，在每张世界卡根目录保存一份 releases.json：

~~~text
data/
└── worlds/
    └── <worldId>/
        ├── source/          # 当前安装版的原始 ZIP/JSON
        ├── package/         # 当前安装版的 world.json、组件与资源
        └── releases.json    # 最近一次成功获取的公开版本目录原始 JSON
~~~

实际目录是 worlds；配置 SERVER_DATA_ROOT 时，整个布局跟随既有 dataRoot，不写死仓库路径，也不根据进程工作目录另算。无需增加独立的缓存目录。

releases.json 直接保存第 4.2 节的公开协议对象，顶层仍为 schema_version、package_id、versions。先完整校验，再保存收到的 UTF-8 JSON 正文；不重新排序或序列化，不增加本地包裹对象、来源字段、检查状态或附属状态文件。允许的未知扩展字段也原样保留。

文件保存所有公开版本记录，包括版本号、标题、发布时间、说明、卡片格式及 artifact 的 URL、格式、SHA-256 和大小。每次成功整体替换为源当前返回的目录，不累积已撤下条目；不提前下载历史卡包或媒体。

该文件属于本地安装的运行信息。世界卡导入不能从包内同名文件建立这份缓存；导出和资源接口继续只处理正式作者内容及 package，不包含根部 releases.json。普通导入仍新建 worldId，不增加管理覆盖导入能力。

### 5.2 读写规则

- usecases/world-updates/ 负责读取、校验和保存流程，统一通过 WorldService 获取原文与 mtime、提交新原文；WorldService 内部复用现有 WorldFileStore 与该世界文件写串行机制。用例和路由均不直接访问 worlds 的私有文件实现。
- GET 的只读投影由 world-updates/read.ts 聚合：从 WorldService 读取文件，再复用本目录 protocol.ts 校验协议、大小和 package_id。文件缺失、损坏或作品身份不符时视为无可用缓存，不影响已安装世界，不隐式访问远端。
- 来源地址仍只保存在正式 publication.update_url。原始目录不含本地来源标记，来源一致性由第 6.2 节的写入与失效流程保证，不能仅凭 package_id 相同就认定文件来自当前 URL。
- check.ts 成功获取并通过完整目录校验、同版哈希检查后，调用 WorldService 保存已校验原文；WorldFileStore 在世界根目录写临时文件，再原子 rename 为 releases.json。本次任务结束清理自己的临时文件，读取时忽略临时文件。
- 网络、协议或写盘失败均保留原 releases.json 及其 mtime；首次失败不生成伪目录或错误 JSON。写盘失败不能返回“刷新成功”。
- 文件发布前，WorldService 在同一世界写串行区间内复核世界存在和当前来源，并执行用例传入的同步任务有效性守卫。保存缓存使用已有目录，不递归创建世界根目录，避免晚到请求重建已删除世界；模块不需要导入 OTA 用例或持有它的内存 Map。
- OTA 只替换 source/package，保留根部 releases.json 原文件及 mtime；删除世界时随整个世界目录一起清理。

### 5.3 检查状态和时间如何得到

文件只保存最后一次成功的远端原始目录。接口需要的本地展示字段按以下方式取得：

| 展示字段 | 来源 |
| --- | --- |
| currentVersion | 数据库 publication.release.version |
| versions | 校验通过的 releases.json |
| latestVersion | 从 versions 按数字三段比较计算；空目录为 NULL |
| lastSuccessAt | 有效 releases.json 的文件修改时间 mtime，表示最后成功保存目录的时间 |
| checking | 当前进程中该世界是否有有效的正在执行的检查 |
| lastAttemptAt / errorCode | 当前进程最近一次检查的内存记录，未检查时为空 |

普通读取、升级和回退不重写 releases.json，也不刷新 mtime。检查失败只更新本次 HTTP 结果及内存状态，旧目录与最后成功时间保持；不为失败单独落文件。

服务重启后，可以立即读取上次成功目录和 mtime；上次进程的尝试时间、失败原因及 checking 状态不保留。本轮启动检查产生新的状态，不能把旧错误或旧“检查中”视为持久事实。文件时间用于提示缓存新旧，不作为发行发布时间或永久检查审计。

检查不修改 publication.release.version、worlds.revision、createdAt/updatedAt、作者内容或运行状态，也不影响列表排序和预览内容身份。

## 6. 启动自动检查与详情主动刷新

### 6.1 启动自动检查生命周期

1. 按现有顺序打开数据库、createServices、createUsecases；在 createUsecases 内创建唯一的 usecases.worldUpdates，随后完成 initialize，包括缺失内置卡的导入。
2. HTTP 开始监听，并等待 listening 成功。
3. server.ts 非阻塞调用同一实例的 checkAtStartup()，截取当时已存在且有合法 publication.update_url 的世界卡列表；调用点或方法内部收敛失败，避免未处理 Promise。
4. 批次逐卡复用 check.ts 的单卡检查，获取目录、校验并经 WorldService 保存。
5. 本轮结束；进程存活期间不再自动启动下一轮。

任务不阻塞服务可用，不让远端失败导致服务启动失败，不递归调用自己，不设置周期定时器。

启动批次与手动刷新使用同一个 createWorldUpdates 实例和同一套单卡检查。首版以 worldId + package_id + update_url 管理正在执行的检查，见第 6.4 节；工厂构造和 initialize 阶段不暗中触发网络。完整装配边界见第 14 节，不增加跨安装副本的长期共享缓存或批次结果重放。

建议并发数 3，目录单次请求超时 10 秒、正文上限 2 MiB、最多 1000 个版本、重定向上限 3。超限按检查失败处理，不截断目录。具体值集中定义并可在实施时按现有规范调整。

### 6.2 异步结果回写条件

请求前捕获 worldId、packageId、updateUrl，并保留本次 inFlight 任务身份。

网络完成后，check.ts 复用 protocol.ts 完成目录校验，并与当前有效旧目录做同版本哈希检查。只有同一实例内有效的单卡检查可以提交文件；不另外暴露绕过检查的保存路由。

随后通过 WorldService 进入现有该世界文件写串行区间，在正式发布 releases.json 前复核：

- 世界仍存在，当前 package_id/update_url 与请求开始时一致，由 WorldService 读取正式记录确认。
- 本次任务仍有效，未因删除或重新建立本地安装而被撤销，由用例传入的同步守卫确认。

不满足就丢弃结果；失效任务也不能覆盖新任务的内存错误状态。仅安装 version、管理名称、标签或模型改变，不让同源结果失效；应用任意版本继续保留当前来源。

删除世界先完成现有授权与删除校验。世界记录删除事务成功提交后，在首次后续异步等待前，通过装配层注入的同步 onWorldDeleted(worldId) 回调调用同一 worldUpdates.cancelForWorld，撤销该世界待处理检查/下载并清除内存检查状态，再清理整个世界目录。删除事务未提交时不改变检查生命周期。缓存发布和目录删除共用现有文件写串行机制；若文件发布已经开始，随后删除会清掉它；若响应晚到，任务及存在性复核阻止写入。不从缓存文件恢复世界，不为缓存写入重新创建目录。

本期没有显式换源入口，OTA 保留当前 update_url。将来若允许修改 package_id/update_url，必须在同一个世界文件写串行区间内撤销旧任务、删除 releases.json、提交新绑定；不能先改绑定再异步删缓存，也不能把删文件和改绑定拆成两个可插队操作。删除缓存失败时不提交新来源。此约束无需增加来源 sidecar 或数据库字段。

### 6.3 关闭与失败

- 将同一实例的 worldUpdates.shutdown() 接入已有 app.shutdown()，与 narrative/replyAssist 的关闭一起等待；继续沿用 startServer.close 的 app.shutdown → 关闭 HTTP → 关闭数据库顺序。
- shutdown 先拒绝新检查/应用操作，取消未完成的目录请求和发行包下载，再等待本实例全部检查、应用、提交及补偿结束；已经进入文件/数据库提交的操作完成提交或补偿后再结束，不能让数据库先关闭。关闭后不再发布文件或访问数据库，不新增关闭框架。
- 每张卡失败独立记录于当前进程，不能中断整批；不把失败状态写入 releases.json。
- 不自动重试，不引入持久队列或执行恢复。
- 有旧成功缓存时仍可展示它，但详情标出上次成功时间和本次失败。
- 单纯检查成功没有 world.updated 事件；该事件只用于实际覆盖后的会话同步。

### 6.4 用户主动刷新与重复请求

- 详情页提供「获取版本列表」或「刷新版本列表」按钮，调用 POST /api/v1/worlds/:id/versions/refresh。
- 服务端仅从该世界当前 publication 取得 package_id/update_url，请求不接受用户临时传入任意下载源。
- 没有 update_url 时按钮不可用并说明「作者未提供更新源」；服务端也校验此条件，不发送网络请求。
- 启动检查和手动刷新共用同一套获取、协议校验、同版哈希检查、来源复核及 releases.json 原子写入逻辑。
- 在 createWorldUpdates 的应用实例闭包内，用 inFlight Map 保存正在执行的 Promise，键为 worldId + package_id + update_url，范围覆盖网络请求直至文件发布结束。启动与所有 HTTP 请求共享这一份 Map；已有同键有效任务时等待该 Promise，不重复请求，finally 只清理自己的任务，避免删掉后来建立的新任务。
- inFlight Map 只负责合并正在执行的请求；任务结束后的下一次主动点击会重新获取目录，不因已有 releases.json 而直接返回旧结果。最近一次尝试/错误、请求取消与关闭状态也由同一实例持有，不落盘、不放入 WorldService 或 RuntimeCache，不按 HTTP 请求重新创建。
- 前端请求期间禁用刷新按钮并显示 loading；启动检查与主动点击重叠时复用正在执行的检查，不再启动第二个同卡请求。
- 普通 HTTP 请求等待检查结束并返回当前版本投影；不新增后台任务 ID、专用进度 SSE 或轮询。
- 此操作只更新远端目录缓存，不下载卡包、不改变已安装版本、不重新初始化状态，也不占用世界安装锁或阻塞叙事/AI 帮答。
- 成功后由 HTTP 响应同步当前客户端的版本列表、详情和列表摘要。失败时保留原列表，结束 loading 并显示错误；可通过已有 GET 接口仅读缓存以同步检查状态。


## 7. 世界列表：前端比较并显示一个红点

### 7.1 列表返回投影

world-updates/read.ts 在现有世界摘要之外生成以下只读投影，类型从该用例目录的 index.ts 公开导出：

```ts
type WorldVersionSummary = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateStatus: "no_source" | "not_checked" | "checking" | "ready" | "failed";
};
```

- currentVersion 来自 publication.release.version。
- latestVersion 从当前世界通过校验的 releases.json 计算，不在数据库或文件顶层重复保存。
- updateStatus 根据 publication、有效目录和本进程检查记录推导：无源为 no_source，有有效进行中任务为 checking，最近检查失败为 failed，其余有目录为 ready、无目录为 not_checked；状态均不落盘。
- 列表通过同一 worldUpdates.getSummaries 批量取得本地更新摘要，不携带完整版本目录；WorldService.list/get 只返回正式世界数据，不反向调用 OTA，不在 route 中发起远端请求。
- 不存储 hasUpdate；避免与当前版本、缓存产生三份状态。

前端：

```ts
const hasUpdate =
  currentVersion !== null &&
  latestVersion !== null &&
  compareReleaseVersion(latestVersion, currentVersion) > 0;
```

比较函数共享严格版本解析；防御性解析失败时不显示红点，不猜测版本次序。

### 7.2 红点规则

- 卡片名称附近或更多操作入口附近显示一个小红点；不闪烁、不增加大标签、不改变卡片整体布局。
- 桌面悬停及无障碍名称提示「有新版本：1.3.0」；移动端不依赖悬停，详情有明确入口。
- 红点表示「当前版本落后」，不是「有未读通知」。
- 打开详情、看完更新说明不会清除红点。
- 安装到最新版本后消失；回退后如果仍有更高版本，红点重新出现。
- 本地版本高于远端最大值不显示红点，不自动降级。
- 检查失败不等于无更新；旧缓存存在时继续按旧缓存比较，详情说明其时效。
- 尚无结果时没有红点，详情显示「尚未获取」，不显示「已是最新版」。

不为红点单独添加 SSE、定时检查或前端轮询。启动检查结果在正常列表读取时显示；用户主动刷新成功时立即同步当前客户端的摘要缓存，重新计算红点。

## 8. 世界详情：版本列表与应用指定版本

### 8.1 入口与布局

保留当前折叠头部、角色条和六个 Tab。在作者/当前版本信息旁增加「版本」入口，有更新时带相同红点；点击打开版本弹窗或移动端抽屉，不新增一级管理页面。

列表按照版本号降序，每条展示：

- 版本号和可选标题。
- 发布时间。
- 更新说明。
- 包大小与格式。
- 当前版本标记。
- 操作按钮。

按钮：

| 目标 | 操作 |
| --- | --- |
| 高于当前 | 更新至 x.y.z |
| 低于当前 | 回退至 x.y.z |
| 等于当前 | 当前版本，禁用 |
| 当前 SR 不支持的卡格式 | 显示需更新 SR，禁用安装 |

本期不做同版本强制重装。发行文件按版本不可变，禁止通过同版本覆盖绕过版本/缓存约定；本地作者内容也没有开放在线编辑器，不增加“检测本地修改”的能力承诺。

### 8.2 目录状态

- 已有缓存：直接展示 releases.json 中的完整目录，并显示由 mtime 得到的最后成功获取时间。
- 检查中：可继续展示上次成功目录，附「正在获取版本列表」，启动或手动检查共用此文案。
- 失败：继续展示旧目录与上次成功时间，附本进程本次检查的简短失败说明；重启不恢复旧错误。
- 首次未完成或新卡尚未检查：显示「尚未获取版本列表」；配置了更新源时提供获取按钮。
- 未配置更新源：显示「作者未提供版本目录」。
- 当前安装版已不在远端目录中：仍展示当前版本摘要，但不伪造其下载记录。

打开弹窗只查询本地缓存。这里的目录是最近一次成功检查（启动或手动）取得的公开版本列表，不声称实时更新。

详情作者/版本区域与版本弹窗提供同一主动刷新操作：

- 无成功缓存：按钮「获取版本列表」。
- 已有成功缓存：按钮「刷新版本列表」，同时展示最后成功时间。
- 请求失败：显示本次错误并允许重试；保留已有成功目录。首次失败不显示「已是最新版」。
- 没有更新源：显示原因，按钮不可用。
- 成功返回空 versions：明确显示「当前更新源暂无公开版本」，不保留已撤下条目充当当前目录。

按钮点击不等于安装。只有用户另行选择目标版本并确认应用，才进入第 8.3 节的覆盖流程。

### 8.3 应用确认

选中一个版本后展示简洁确认：

「将世界卡从 v1.2.0 覆盖为 v1.3.0。已有会话将使用目标版本的角色、世界书和舞台；消息与运行状态保留。」

回退时明确按钮和目标版本。确认后禁用本次操作按钮并显示下载/应用中的状态。首版使用普通 HTTP 请求等待结果，不引入安装任务队列或专用进度 SSE。

更新成功后：

- 用返回世界详情替换当前数据。
- 重新比较红点。
- 刷新世界列表摘要。
- 重建发行内容对应的预览，校准当前选中的角色和开局。
- 保留本地会话与管理设置。

## 9. 原地覆盖的明确语义

### 9.1 同一个 worldId

覆盖修改当前 worlds 行与该 ID 的 source/package 文件，保持：

- worldId 和 createdAt。
- 全部 sessions.worldId。
- 已有消息、usage、摘要、tip 与玩家身份。
- worlds.state、sessions.state、entries.state。
- 用户设置的世界名称、标签、默认叙事/帮答预设、默认模型及封面马赛克开关。
- 当前绑定的更新源和已有同源版本目录缓存。

目标版本覆盖：

- 介绍、封面、角色、开局、世界书。
- 状态定义、消息渲染规则。
- 组件、舞台入口、作者扩展；extensions 内属于本地管理的键（例如封面马赛克配置）显式保留，不随作者扩展整体覆盖。
- 作者信息、发行版本、发行说明等 publication。

名称和标签沿用当前产品允许用户管理的语义，本期全部按本地设置保留；若作者新版改名或调整标签，不自动覆盖用户已安装副本。用户可通过现有管理入口自行调整。

普通导入时自动套用应用默认模型/预设的逻辑不能直接用于覆盖。更新入口需要显式保留当前世界配置。

### 9.2 运行状态不会重新初始化

cardToWorld 当前会生成初始 global 状态；覆盖路径必须丢弃这份初始化写入，不把 CreateWorld 整体展开覆盖运行字段。

- 不重新播放开局，不重建第一条 assistant 消息。
- 不给旧消息或旧会话偷偷补初始状态。
- session/message 的 initial 只在未来新建会话时按既有规则生效。
- global 的新 initial 在同 worldId 覆盖时不生效，因为 global 继续保留；作为新世界导入时才按该初始值建立。
- 改 rules/load 可以影响后续模型上下文和更新行为，但不是对历史状态重新结算。

### 9.3 回退不回退更新源

通过当前目录应用旧版本时：

- 包内 package_id 必须与本地作品一致。
- 保留本地已有 update_url，旧 ZIP 的历史 update_url 不覆盖当前绑定。
- 保留根部 releases.json 原文件及 mtime，因此回退后仍可从目录得知远端最新版本，不把回退操作误记为一次成功检查。
- 更换更新源不作为发行覆盖的附带动作；将来单独设计显式来源管理。

这里的包哈希校验针对下载原始字节；保存到数据库的作者内容仍会经过现有解析，以及上述本地管理字段/来源保留规则。原始下载文件可作为 source 保存，导出则使用当前 DB 内容和资源，沿用现有导出语义。

### 9.4 基础兼容检查

在没有状态迁移能力的前提下，首版采用明确且保守的门槛：

| 检查 | 规则 |
| --- | --- |
| 作品身份 | package_id 必须一致 |
| 目标发行 | 包内 version、spec_version 与选定目录记录一致 |
| 玩家身份 | 所有现有会话使用的 userCharacterId 在目标卡中仍存在且 player_selectable=true |
| global 状态根 | 同一安装持续保留 global，原/目标根集合和根类型必须一致 |
| session/message 状态根 | 有现有会话时，原/目标根集合和根类型必须一致 |
| 数字约束 | 对需保留数据的 scope，允许放宽 min/max；本期拒绝收紧，避免扫描全部历史快照 |
| rules/load/initial | 可以修改；不触发运行值重置 |
| 没有会话时的 session/message 定义 | 可以修改，未来会话按目标版本初始化 |

当前会话不保存 openingId，原开局正文已成为历史；不人为增加旧开局 ID 必须保留的限制。

不对全部历史调用要求根集合严格相等的快照校验器，避免破坏现有允许空/稀疏消息快照的行为。

当前 json 类型并没有声明完整的嵌套 schema。上述检查不能证明 JSON 内部路径、组件业务语义或剧情一定兼容；作者需保持旧数据所需路径和含义。平台不引入自创 JSON schema 或自动语义迁移。

不满足门槛时返回具体角色或状态根原因，原安装保持不变；需要大改结构的版本可通过现有普通导入作为新世界使用。这是原地覆盖在本期的适用范围，版本升降都执行相同检查。

## 10. 覆盖执行流程与文件处理

本流程由 world-updates/apply.ts 编排：获取目录与目标版本、调用共享下载工具、协调世界/会话服务与 RuntimeCache，最后发布提交后事件。文件替换、兼容校验及正式世界记录写入仍通过 WorldService 的受控能力执行，用例不直接导入私有 repository、files 或替换目录。

### 10.1 准备阶段

1. 读取当前世界及其通过校验的 releases.json，选择用户指定的版本记录；来源一致性沿用第 6.2 节的生命周期约束。
2. 验证 expectedRevision 和 expectedSha256，拒绝目录已变化或同版本操作。
3. 若已知该世界存在叙事或 AI 帮答运行，可提前拒绝以避免无效下载。
4. 从缓存记录取得 URL；不接受前端任意传入下载 URL。
5. 在临时目录下载，检查格式、实际大小和 SHA-256。
6. 复用现有解析、ZIP 路径/资源校验及卡协议验证。
7. 确认包内身份与目标版本一致，得到待提交作者内容。

网络和解包阶段不持有世界更新占用。文件暂存失败只清本次暂存。

### 10.2 最后应用阶段

1. 获取目标 worldId 的短暂更新占用；拒绝同世界活跃叙事 Run、AI 帮答或其他覆盖。
2. 重新读取当前世界，复核 expectedRevision、来源和目标记录。
3. 检查会话玩家角色及需保留的状态定义兼容。
4. 在该世界文件写串行区间内，仅将旧 source/package 暂移到本次操作的备份位置，再发布新 source/package；世界根目录和 releases.json 原位保留。
5. 在短同步数据库事务中 CAS 更新作者内容和 publication，revision 加一；不写运行 state 和本地保留字段。
6. 数据库成功后清理本次 source/package 备份，释放占用，再发提交后事件。
7. 返回最新世界详情。

文件/数据库通过暂存和补偿协调，沿用当前仓库原则，不宣称跨文件与数据库的强事务。

普通失败时恢复旧 source/package 并回滚数据库；回滚失败必须给出明确清理/恢复错误，不能假装更新成功。DB 已提交后的临时备份清理失败不再把已生效更新当作未完成，应记录清理信息并保留成功结果。根部 releases.json 不参与替换或回滚。

临时备份仅服务本次替换失败补偿，不是长期历史版本。

### 10.3 必须区分导入与替换的文件能力

- 复用 stageImport 和 readImportPackage 的准备/校验能力。
- 现有 publishImport 拒绝已存在目标，新增明确的替换发布方法。
- 现有 discardImport 在 published 分支可能删除整个目标目录，不能直接拿来补偿覆盖。
- 原件 source 和 package 作为同一次覆盖切换，确保「下载原件」对应当前安装。
- 替换整个 package，不能只将新文件覆盖到旧目录，否则新版已删除文件会残留。
- 不整体替换世界根目录。根部 releases.json 既不来自新卡包，也不从准备阶段的旧快照复制回来；让它原位保留，避免覆盖下载期间刚刷新的版本目录或改变其 mtime。
- 删除、导入发布等写操作复用现有文件串行机制；现有导出并没有被该机制串行保护，不能假定它已安全。
- 导出、组件批量读取和单资源打开，在开始与返回前复核更新占用和捕获的 revision。若覆盖发生，丢弃本次构建结果或关闭已打开流，返回可重试错误，避免交付旧 JSON 加新资源。
- 完成且通过复核的导出临时 ZIP 可独立流式发送；单资源流使用其打开时对应的验证标识，不能给旧流挂上新版 ETag。无需为此引入通用读写锁。

## 11. 运行锁与已打开页面

### 11.1 只扩展现有内存 RuntimeCache

新增轻量 world 更新占用，不新增持久锁、分布式锁、后台执行框架。

占用期间：

- 同世界新的叙事 Run 和 AI 帮答不能开始；现有两类运行都必须在准入时记录或可明确取得 worldId。
- 不能创建该世界的新会话。
- 不能对该世界关联的 global/session/message 状态或会话执行冲突写入。
- 阻挡第二次覆盖、删除和管理写入。
- 世界详情、组件和资源在短暂替换窗口不能读到 DB/文件混合版本，可返回明确的正在更新结果。
- 其他世界、已有历史读取与停止操作保持现有行为。

只在替换前检查「当前无 Run」不足够：文件 await 期间新 Run 或 AI 帮答可能开始。因此 acquireRun、acquireReplyAssist、会话创建及相应写入口也必须识别世界更新占用。当前 assertGlobalStateWrite 只检查活跃叙事，不能当作完整的 OTA 更新准入。

RuntimeCache 不查询数据库；调用方提供世界归属。内部覆盖 permit 只在服务端持有，不通过 HTTP/SDK 传播。

### 11.2 详情预览失效

previewContentIdentity 增加 publication.release.version；更新版本改变，即销毁原预览池、取消旧源码请求、重建桥接并读取新源码。

同一路径 components/Main.tsx 的内容变化必须重新获取，不能只比较 components 声明数组。

- 本期禁止同版本不同包应用，因此不需要新增通用 contentRevision 字段。
- 管理名称/标签/默认模型变化不改变内容身份，不重建预览。
- 编译缓存已按源码内容判断，可以继续复用。
- 更新后校准本地角色/开局选择，避免保留目标版本不存在的选项。

### 11.3 HTTP 资源再验证

继续使用现有 /api/v1/worlds/:id/resources/* 路径，不在 assetBaseUrl 后直接拼 query；SDK 当前拒绝带 query 的资源基地址。

对可覆盖的资源使用 Cache-Control: no-cache 和可靠的 ETag/If-None-Match 再验证。发行卡的验证标识至少纳入 worldId、package_id、安装发行版本和资源路径；旧无发行信息卡可使用管理 revision 作为保守失效标识。保证任何实际资源替换都会改变对应验证标识，不能用只看文件名的 ETag。

覆盖后重建相应视图，让图片、音视频发起新加载。外部 HTTP(S) 素材由外部服务器控制，SR 不能保证其内容固定；需要稳定回退的作者应将素材打入 ZIP。

### 11.4 已打开会话

覆盖后，现有会话 worldId 不变，服务端下一轮自然读取目标版本。为避免别的标签页还显示旧舞台：

- 复用已有会话 SSE，对该世界关联会话发送 world.updated。
- 按会话 fanout，payload 包含 sessionId、worldId、version、revision、timestamp；提交成功并释放更新占用后发送。现有客户端会校验 sessionId，不能省略。
- 在 Web session-events 中增加 world.updated 监听名和 world namespace。底层通用 SSE 传输器继续仅传输，不增加世界业务判断。
- workspace 重取世界与组件；SessionPage 以 worldId 与已安装 release.version 组合为 StageHost 的内容 key，发行版本变化时重建舞台 iframe 与桥接，清除同 main 下可能保留的旧错误状态和媒体 DOM。
- 仅重建舞台，保留会话 workspace、历史、输入草稿和独立叙事连接；只向旧 iframe 发 render 不足以保证资源刷新。
- SSE 重连补一次当前世界版本核对，避免漏掉短暂通知。
- 不新增全局 SSE，不对启动或手动版本检查发送该事件，不将更新目录作为会话事件传输；手动刷新由 HTTP 响应同步发起端。

## 12. HTTP / Web 契约

统一 /api/v1 前缀和现有成功/错误包络，以下路径省略前缀。

| 接口 | 行为 | OTA 入口 |
| --- | --- | --- |
| GET /worlds | 本地摘要，增加 currentVersion/latestVersion/updateStatus；零远端调用 | worldUpdates.getSummaries，批量聚合 |
| GET /worlds/:id | 当前作者内容和 publication，提供精简检查状态；零远端调用 | worldUpdates.getSummaries，单卡投影 |
| GET /worlds/:id/versions | 读取 releases.json，结合 publication 与内存检查状态返回版本目录、当前版、最新版和时间/结果；零远端调用 | worldUpdates.getVersions |
| POST /worlds/:id/versions/refresh | 用户主动获取该卡的远端目录，校验并原子保存 releases.json，返回更新后的版本投影 | worldUpdates.refresh |
| POST /worlds/:id/apply-version | 依据缓存版本记录下载并覆盖当前世界 | worldUpdates.applyVersion |

这些均为玩家本地 SR 的接口，发布方不需要实现。获取指定版本的原件已由第 4.0 节的 artifact.url GET 完成，不再要求发布方提供固定下载路由，也不把本地“导出当前安装”冒充某个发行版原始文件。

主动刷新 POST 无需业务请求体，复用现有统一响应包络。成功返回与 GET /worlds/:id/versions 相同形状的数据，至少包含 currentVersion、latestVersion、检查状态/时间和完整版本列表。失败返回标准错误，原 releases.json 及其 mtime 保留，本次尝试和错误仅记录在当前进程内存；GET 接口始终仅读本地数据。文件路径不作为 API 字段返回。刷新不修改 publication.release.version、worlds.revision 或作者内容。

应用请求：

```json
{
  "version": "1.3.0",
  "expectedSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "expectedRevision": 7
}
```

- expectedSha256 必须与当前缓存的目标版本记录一致。
- 下载 URL 由服务端从本地缓存读取。
- 下载期间允许其他无关操作；最后应用时重新检查 revision。
- 成功返回 data.item（当前世界详情），供前端立即替换。
- 失败按阶段清理；不改变已安装 version，更不能仅改版本号而未替换文件。

建议集中定义必要错误：未取得目录、目标版本不存在、来源/身份不匹配、目录或 revision 冲突、下载/哈希失败、世界忙、玩家角色不兼容、状态定义不兼容、替换/补偿失败。错误显示具体原因，不泄漏本地文件路径或原始网络凭据。

## 13. 创作者操作说明

本节描述任意发布方维护发行源的流程。第一版只要求公开 JSON 和文件，可由创作者、社区或第三方服务托管；没有统一源注册、provider 类型或官方域名要求。[集中发布方案](world-card-publishing-hub.md)只是将这些步骤自动化的一种可选实现。

### 13.1 首次准备

1. 创建世界源码目录，沿用 world.json、components/、assets/ 布局。
2. 生成一次 package_id 并写入源文件，之后不随打包重新生成。
3. 填写 authors、creator_notes、homepage 和固定 update_url。
4. 编写当前版本与更新说明。
5. 将所有希望随版本固定的组件和媒体放进包内，用 sr-asset:// 引用。

发布目录示意：

```text
worlds/fog-harbor/
├── releases.json
└── versions/
    ├── 1.1.0/fog-harbor.zip
    ├── 1.2.0/fog-harbor.zip
    └── 1.3.0/fog-harbor.zip
```

ZIP 内沿用：

```text
fog-harbor.zip
├── world.json
├── components/
│   └── Main.tsx
└── assets/
    └── images/
```

### 13.2 每次发版

1. 修改世界内容，并递增版本。
2. 写本版 notes；已有剧情/状态结构不兼容时在说明中明确建议新开世界。
3. 运行发行脚本，校验源卡与文件引用。
4. 生成包含新 publication 的 ZIP，计算最终 ZIP 的 sha256 和 size_bytes。
5. 将发行对象追加到本地 releases.json，保留旧发行对象。
6. 先上传新 ZIP 到固定版本路径，确认可直接下载。
7. 再上传覆盖固定 releases.json。
8. 用户下次启动 SR，或在详情主动刷新版本列表后，获得新的目录缓存；世界列表按版本差显示红点。

不先公布目录再上传文件；不把旧版本下载链接统一重定向到最新 ZIP；不使用 latest.zip 作为每个历史版本的共同下载目标。

### 13.3 发行脚本的职责

已提供 scripts/release-world.ts 与 pnpm world:release 命令：

```bash
pnpm world:release \
  --dir ./my-world \
  --version 1.3.0 \
  --notes ./release-notes.md \
  --artifact-url https://cdn.example.org/worlds/fog-harbor/versions/1.3.0/fog-harbor.zip \
  --index ./releases.json \
  --out ./dist-world
```

脚本：

- 从源 world.json 读取固定 package_id、作者和 update_url；package_id 缺失时拒绝发版，避免每次生成不同作品身份。
- 读取 notes，按同一份发行数据生成包内 publication.release 和目录记录。
- 发布时间缺省使用实际打包时间，可显式指定用于可复现发布。
- 复用正式卡片/资源校验，不维护另一套弱校验器。
- 读取旧发行目录与生成新目录时，复用 world-updates/index.ts 显式公开的纯 validateReleaseIndex；脚本只调用纯协议函数，不创建 createWorldUpdates 实例、不打开玩家运行数据库、不发起更新检查。
- 输出版本 ZIP、最终哈希、大小和更新后的 releases.json。
- 同版本记录已存在则拒绝覆盖，要求新版本号。
- 本期只生成发布文件，不集成上传凭据、不自动推送到外部托管。

已有不超过上传限制的 JSON 卡也可由同一协议发行；包含离线媒体的世界统一推荐 ZIP。

### 13.4 作者需要提供给玩家什么

首次分享时提供当前 ZIP，或提供其直接下载链接。ZIP 内 publication.update_url 已包含固定版本目录地址，玩家导入后无需再填写一套订阅配置。

作品主页面向人；update_url 面向程序；artifact.url 面向某一版实际文件。三种链接职责清楚，不要求作者建设额外产品网站。

## 14. OTA 用例组织与文件改动范围

### 14.1 采用独立 usecases/world-updates 目录

启动异步检查、主动刷新、本地版本查询、下载与指定版本应用组成同一项 OTA 应用能力，集中放在 usecases/world-updates/。沿用现有 narrative/reply-assist 的组织方式，由一个工厂创建一份应用实例状态，不再将检查和应用散落为 usecases 根下的独立入口。

“保存到本地”这一业务步骤属于 OTA 用例；世界目录如何定位、串行写入和原子替换仍由 worlds 模块负责。其原因是 releases.json 与 source/package 共用同一世界生命周期和文件写队列，若用例另建一套磁盘写入，会让刷新、删除和覆盖失去共同的串行边界，也会绕过现有模块访问约束。

### 14.2 具体职责与依赖方向

| 归属 | 负责 |
| --- | --- |
| world-updates/index.ts | createWorldUpdates、唯一公共入口、应用实例状态、取消与关闭；组合内部函数 |
| world-updates/types.ts | 公开输入输出、版本摘要与内部执行类型；公共类型经 index.ts 显式导出 |
| world-updates/protocol.ts | 纯公开版本目录协议：结构与身份校验、同版哈希一致性、版本排序/选择；不执行 I/O |
| world-updates/read.ts | 聚合 publication、本地 releases.json/mtime 与内存检查状态，生成完整版本视图或批量摘要 |
| world-updates/check.ts | 单卡远端获取、协议校验与保存编排；启动批次复用同一检查 |
| world-updates/apply.ts | 选版、下载校验、兼容检查调用、覆盖事务编排与提交后事件 |
| world-updates/downloads.ts | 目录和发行文件共用的受限 HTTPS 获取、大小/哈希检查；只处理网络及本次下载暂存 |
| worlds 模块 | WorldPublication、卡协议 0.2/0.1、publication_json、正式导入导出、内容兼容校验、世界目录及文件操作 |
| 现有 SessionService / RuntimeCache / EventHub | 会话和玩家信息、运行与覆盖占用、提交后通知；由用例组合使用 |

版本号语法与比较继续使用 packages/sr-sdk/src/release-version.ts 的纯函数，worlds 校验 publication 与 OTA 解析远端目录共用；worlds 不为校验卡片而反向导入 world-updates。

WorldService 提供读取 releases.json 原文/mtime、在既有串行区间内提交原文、删除文件以及替换正式内容的受控操作。保存时由 WorldService 复核正式作品与来源，并执行用例传入的同步有效性守卫；它不负责 HTTP 拉取、远端目录解析、版本选择、检查状态或红点计算。WorldFileStore 不认识 OTA 的 inFlight Map。

用例只能从 modules/worlds/service.ts 取得服务及显式导出的领域类型，不直接导入该模块私有 types.ts、repository.ts、files.ts 或兼容校验实现。其他领域模块也遵守各自 service.ts 出口；模块不导入 usecase，路由不写 SQL 或文件。

发布脚本可以从 world-updates/index.ts 使用显式导出的纯 validateReleaseIndex 及目录类型。入口和内部依赖在模块加载时不得触发网络、读取运行配置/数据或创建 OTA 运行实例；所有运行状态由工厂调用时建立。这样共享同一份协议校验即可，无需为首版新增协议包，也不让发布脚本启动玩家更新流程。

### 14.3 实例装配与生命周期

在 apps/server/src/usecases.ts 调用一次 createWorldUpdates，返回 usecases.worldUpdates。server.ts、HTTP 路由和删除用例共享这一实例，services.ts 不另建 OTA 服务，工厂也不在请求处理或启动检查中重复调用。

| 公开方法 | 消费方与用途 |
| --- | --- |
| getVersions | 版本列表 GET；只读本地正式信息、目录文件与内存状态 |
| getSummaries | 世界列表/详情；按已有查询结果批量读取本地更新摘要 |
| refresh | 详情刷新 POST；复用或创建单卡检查 |
| checkAtStartup | server.ts 监听成功之后调用一次；逐卡复用刷新流程，不阻塞服务可用 |
| applyVersion | 应用指定发行版 POST |
| cancelForWorld | 删除成功提交后的同步回调；撤销待处理检查/下载，清除该世界内存记录 |
| shutdown | 接入现有 app.shutdown；拒绝新任务、取消网络、等待检查与应用收尾 |

inFlight、最近检查记录、AbortController 与正在收尾的操作都由该实例闭包持有。RuntimeCache 只扩展世界覆盖占用，不承载目录、检查结果或 OTA 调度。

delete-world.ts 只接收同步窄回调 onWorldDeleted: (worldId: string) => void；createUsecases 将它绑定到 worldUpdates.cancelForWorld。回调在删除事务提交后、首次后续 await 前执行，再由现有世界文件删除流程清理目录。删除用例无需深导入 OTA 内部文件，WorldService 也不反向调用 OTA。

应用外部只从 world-updates/index.ts 导入工厂、公共类型和明确公开的纯协议函数。内部 read/check/apply 等文件通过参数取得依赖及共享状态，不从 index.ts 回导运行实例。为这个新目录补充与现有 context 相同范围的入口 ESLint 规则和架构测试；保持现有模块边界，不放宽规则。

不增加 manager、scheduler、cache-repository、全局任务服务或另一套关闭流程。普通导入仍是新建世界，保持现有拒绝覆盖的规则。

### 14.4 实施文件目录

以下是实际实施目录树；[新增]/[修改] 标出本次交付范围，相关函数测试随能力一同增加或调整。

~~~text
/Users/wanghuiru/Workspace/SillyRealms/
├── apps/server/
│   ├── eslint.config.mjs                     [修改] world-updates 唯一公开入口约束
│   └── src/
│       ├── server.ts                         [修改] 监听成功后调用单次检查
│       ├── usecases.ts                       [修改] 创建唯一 OTA 实例、注入删除回调
│       ├── app.ts                            [修改] 接入同一实例的 shutdown
│       ├── errors.ts                         [修改] 集中更新相关错误
│       ├── infrastructure/
│       │   ├── database/connection.ts        [修改] 仅新增 publication_json 的结构迁移
│       │   └── cache/index.ts                [修改] 短暂世界覆盖占用
│       ├── modules/worlds/
│       │   ├── types.ts                      [修改] WorldPublication 与受控文件操作类型
│       │   ├── validation.ts / parser.ts     [修改] publication、0.2/0.1 解析与导入导出
│       │   ├── update-validation.ts          [新增] 玩家引用及状态兼容检查
│       │   ├── repository.ts                 [修改] publication 读写与 CAS 内容覆盖
│       │   ├── service.ts                    [修改] 受控文件/覆盖能力及领域类型公开出口
│       │   ├── files.ts                      [修改] releases.json 原文读写、子目录替换与补偿
│       │   └── authoring.ts                  [修改] 发行打包时覆盖publication，源文件保持原样
│       ├── modules/sessions/service.ts       [修改] 写入口识别世界覆盖占用
│       ├── usecases/
│       │   ├── world-updates/                [新增] 集中的 OTA 应用能力
│       │   │   ├── index.ts                  [新增] 公共入口、唯一实例状态与生命周期
│       │   │   ├── types.ts                  [新增] 版本视图、摘要与执行类型
│       │   │   ├── context.ts                [新增] 实例依赖、任务状态及失效守卫
│       │   │   ├── protocol.ts               [新增] 纯版本目录校验、排序与选择
│       │   │   ├── read.ts                   [新增] 本地版本详情与批量摘要
│       │   │   ├── check.ts                  [新增] 单卡拉取、校验、保存与请求复用
│       │   │   ├── apply.ts                  [新增] 指定发行版下载与覆盖编排
│       │   │   └── downloads.ts              [新增] 受限 HTTPS 与下载校验
│       │   ├── reply-assist/index.ts          [修改] 帮答占用关联worldId
│       │   ├── set-state.ts                  [修改] 覆盖期写入互斥
│       │   └── delete-world.ts               [修改] 删除与覆盖互斥，提交后调用撤销回调
│       ├── routes/worlds.ts                  [修改] 调用 OTA 公共入口与资源再验证
│       └── testing/architecture.test.ts      [修改] 模块及 OTA 唯一入口边界验证
├── apps/web/src/
│   ├── features/worlds/
│   │   ├── api/worlds.ts                     [修改] publication、版本读取、刷新与覆盖契约
│   │   ├── WorldCard.tsx / WorldLibraryPage.module.css
│   │   │                                     [修改] 版本比较及红点
│   │   ├── WorldDetailPage.tsx               [修改] 作者版本入口、主动获取按钮与应用后刷新
│   │   ├── WorldPublication.tsx / .module.css
│   │   │                                     [新增] 作者信息、全版本列表和应用确认
│   │   ├── versions.ts                       [新增] 版本请求、取消、状态与操作控制
│   │   └── preview-cache.ts / stage-world.ts [修改] 发行版本变化重建预览和舞台
│   ├── features/sessions/workspace.ts        [修改] 更新后/重连后重载世界内容
│   ├── features/sessions/SessionPage.tsx      [修改] 发行版本变化时重建舞台，保留 workspace
│   ├── transport/session-events.ts           [修改] 分发 world.updated
│   ├── features/character-sprites/controller.ts
│   │                                         [修改] 世界更新后重新取当前立绘目录
│   ├── components/ui/Modal.tsx / .module.css [修改] 复用弹窗增加移动抽屉展示
│   └── i18n/locales/                         [修改] 跟随当前中英日文案体系
├── packages/sr-sdk/
│   ├── src/release-version.ts                [新增] 前后端共享稳定版本比较
│   ├── src/stage-contract.ts / src/stage/index.tsx
│   │                                         [修改] 会话事件类型及公共类型导出
│   └── package.json                         [修改] 导出纯版本比较子路径
├── scripts/release-world.ts                  [新增] 复用纯校验，生成发行产物及目录
├── scripts/world-card-checks.mts             [新增] 原打包命令与发行命令共用组件检查
├── scripts/world-card.mts                    [修改] 复用提取后的检查函数
├── package.json                             [修改] 发行脚本命令
├── docs/
│   ├── world-card.json                       [新增] 正式 publication 示例
│   ├── reference/world-card.md               [修改] 0.2 作品发行信息字段
│   ├── reference/world-updates.md            [新增] 公开 OTA v1 的规范契约
│   ├── creator/world-publishing.md           [新增] 作者发布与链接说明
│   ├── runtime/server-http.md                [修改] publication、列表/版本/覆盖契约
│   ├── runtime/server-events.md              [修改] 提交后世界更新通知
│   └── runtime/web-management.md / web-runtime.md
│                                             [修改] 红点/覆盖/舞台刷新行为
└── plan/
    ├── world-card-versioning-v1.md            [修改] 本协议与实施方案
    └── world-card-publishing-hub.md           [修改] 可选托管与 publication 契约一致
~~~

删除文件：无。对应函数测试随所属协议、读取、检查、应用和文件能力增加或调整；不因目录组织重构 context/state 常规算法、资源寻址协议或整个管理页面。运行时 releases.json 的数据布局见第 5.1 节，它由检查流程生成，不是仓库交付文件。

## 15. 实施结果与验收

### 已完成：协议和本地投影

- 0.2 publication、0.1 卡兼容、唯一新增的 publication_json 列，以及世界根部 releases.json 的原始目录读写。
- 导入导出保留 publication 且不带检查缓存。
- world-updates/protocol.ts 的纯全版本目录校验，与共享 release-version 比较函数。
- createWorldUpdates 唯一实例装配、公共类型与入口边界；列表/详情通过 read.ts 聚合本地字段。

### 已完成：启动检查、主动刷新和版本展示

- checkAtStartup 与 refresh 共用同一实例和 check.ts，保存经 WorldService 进入既有文件串行区；合并同卡正在执行的请求。
- 接入现有 app.shutdown 和删除成功后的同步撤销回调，确保 GET、启动任务与所有路由看到同一份内存状态。
- 失败保留原文件及 mtime、来源与任务有效性复核、内存检查状态、列表红点和版本详情。
- 主动刷新成功后立即同步当前客户端摘要与版本列表。
- 不在普通列表/详情 GET、打开页面或导入完成时隐式增加远端检查。

### 已完成：指定版本覆盖

- apply.ts 复用导入准备，经 WorldService 完成同 worldId 文件替换与 CAS 提交；下载及校验复用同目录的公共内部能力。
- 运行状态/本地配置保留及明确兼容门槛。
- 短暂世界占用、预览失效、资源再验证、已打开会话刷新。

### 已完成：创作者发布工具与说明

- 从一份发行信息生成 ZIP、哈希、大小和完整目录。
- 文档提供可复制的字段、链接形态、发布顺序与失败排查。

### 必要验收场景

1. 1.10.0 大于 1.9.0；非法/预发行版本不混入本期排序。
2. 单次启动自动批次每张世界卡至多检查一次；普通页面 GET 不新增远端请求，明确的主动刷新 POST 可以再次获取。
3. 服务已可用时检查仍可进行；远端失败不影响启动；已有 app.shutdown 等待检查、应用和提交/补偿结束，随后无晚到目录发布或数据库访问。
4. 失败保留原 releases.json 与 mtime，latestVersion 仍从旧目录计算；没有有效文件不假装最新版。
5. 来源变化或世界删除使旧任务失效；晚到成功或失败都被丢弃，不重建目录，也不污染后来任务的内存状态。
6. 新导入卡不自动补查，但用户可立即主动获取版本列表，无需重启；启动首屏读取时序符合第 1.1 节。
7. 查看说明不消红点，升级后消失，回退后重新出现。
8. 同名不同 package_id 拒绝应用；重复版本/同版哈希变更拒绝目录。
9. ZIP/JSON 下载失败、哈希不符、解包或 DB 失败时当前内容保持或恢复。
10. 覆盖不改变世界 ID、消息、三 scope 状态、默认模型/预设和本地管理字段。
11. 缺少已有玩家角色、状态根/类型不兼容、范围收紧时在替换前拒绝。
12. 下载期间可正常运行；最终覆盖与叙事/AI 帮答、新会话、状态写入互斥，其他世界不受影响。
13. 同路径组件替换后重新获取，资源不沿用旧验证标识；管理名称变化不重建预览。覆盖前已开始的导出/组件读取若横跨替换，结果被丢弃而非交付混合包。RuntimeCache 在正式覆盖占用时递增读取 epoch；即使本次覆盖回滚且 DB revision 未变，也使此前开始的读取失效。
14. 已打开会话能通过 sessionId 校验接收 world.updated，发行版本变化重建舞台；断线重连可补查，输入草稿和历史保持。
15. 升级和回退不改变 update_url；只置换 source/package，保留 releases.json 原内容及 mtime，包括下载期间刷新得到的新目录。
16. 发行脚本给出真实 SHA-256 与大小，同版重复发布被拒绝。
17. 两个不同来源、任意路径的合规目录都能被同一客户端读取；目录与文件跨域无需 provider 分支。
18. 指定旧版本只下载该记录的 artifact.url；不访问 latest 路径，不用当前安装导出代替原件。
19. creator_notes 与 release.notes 分别导入、导出、展示；作者说明不注入模型提示词。
20. 未部署 Hub、Discord 或其他集中服务时，仅有静态 JSON 与 ZIP 的来源即可完成检查与应用。
21. 主动刷新成功后立即更新版本弹窗、详情与列表红点；远端已撤下条目不被累计保留。
22. 启动检查与手动刷新重叠、重复点击时，同卡仅有一个正在执行的请求；结束后再次点击可重新获取，不出现旧结果晚到覆盖。
23. 主动刷新失败保留旧目录/lastSuccessAt，本次尝试和失败只留在内存；重启可读旧文件，但不恢复旧错误或 checking。首次失败不生成错误目录、不显示最新版。
24. 主动刷新持久写入仅涉及世界根部 releases.json，不改数据库字段、内容 revision、作者文件和运行状态；不添加本地包装字段或状态 sidecar。
25. 自定义 SERVER_DATA_ROOT 时，版本文件仍位于该根下 worlds/<worldId>/；成功保存保留原始 JSON 正文及允许的未知扩展字段，写盘失败不得覆盖旧文件或返回成功。
26. 文件缺失、损坏、package_id 不符时按无可用缓存返回，普通 GET 不触发网络；之后启动检查或手动刷新可重新建立文件。
27. 导入不信任包内同名文件作为本地目录；导出和资源接口不包含世界根部 releases.json；删除世界会一并删除文件，晚到检查不能创建已删除的目录。
28. 世界卡 JSON、DB 映射、HTTP DTO、前端读取与导入导出统一使用 publication / publication_json / WorldPublication；无重复的正式发行信息对象或旧名兼容列。
29. 一个应用实例内，启动、刷新、GET 和删除撤销共享同一 worldUpdates；两个独立应用实例不共享检查状态，重复构造或按请求创建不能通过装配测试。
30. 读取/检查/应用函数从公共 index 进入，usecase 不访问 worlds 私有文件；worlds 不依赖 OTA 用例，入口规则由现有 ESLint 与架构测试覆盖。
31. 发行脚本只调用公开的纯目录校验函数，导入该公开出口不会触发网络、运行配置/数据读取或创建 OTA 实例；不引入第二套目录验证实现。
32. 刷新与世界删除/覆盖共用原有文件写队列；文件保存接受捕获来源和同步任务有效性守卫，不在用例内另建正式世界目录写入路径。

验证以函数测试、临时目录/临时库、typecheck/lint 为准；不读取真实运行数据库和凭据。测试覆盖协议排序、原文保存、异步失效、升级/回退保留、文件与数据库失败补偿、写入互斥、HTTP函数契约、前端控制器及发行产物。浏览器交互与真实来源联网验证不在本次已完成检查之内。

2026-11-26 验证结果：

| 检查 | 结果 |
| --- | --- |
| 服务端函数套件（vitest run --exclude src/server.test.ts --silent） | 通过 |
| 最后摘要读取调整后的相关测试 | 6 个文件、93 项全部通过 |
| Web 全部函数测试 | 213 项全部通过 |
| 前后端 pnpm typecheck | 通过；最后服务端调整后再次通过 |
| pnpm lint、发行脚本独立 ESLint / strict TypeScript | 通过 |
| 原有世界卡工具与新增发行脚本测试 | 通过，包括真实 ZIP/哈希/大小、源文件不变和最终索引字节上限 |
| 正式示例 world:check、文档链接与 JSON 块、git diff --check | 通过 |

首次执行仓库服务端全量命令包含既有 src/server.test.ts，其中 CLI 子进程的 4 秒启动等待超时。后续按仓库函数测试范围显式排除该真实 HTTP/CLI 测试文件，没有修改或删除其测试，也不将该次全量命令记为通过。

## 16. 参考与设计来源

本方案的外部机制参考沿用本轮对话已核对的一手资料；字段和首版取舍是 SR 自身设计，不是声称行业存在完全相同标准。

- Foundry 模块清单中的稳定 manifest、下载 ZIP 与版本：https://foundryvtt.com/article/module-development/
- Foundry 发行记录与更新说明：https://foundryvtt.com/article/package-management/
- SillyTavern 作者与角色版本元信息：https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- Character Card V2 将格式版本与内容版本分开：https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- Character Card V3 的作者说明与来源定义：https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- SemVer 的数字分段比较与发行后内容不变原则：https://semver.org/lang/zh-CN/ 。本方案首版仅采用不含预发布/构建后缀的数字三段子集。

本方案正式收口为：data.publication / publication_json 保存作品发行信息 + 每个世界根目录一份原始 releases.json + usecases/world-updates 集中读取、检查、下载和覆盖编排。启动自动一轮与用户主动刷新共用唯一实例，底层世界存储仍复用 WorldService；最新版从文件计算，检查状态只在内存维护。保留前端红点与同 worldId 覆盖，不增加公开版本数据库缓存、独立缓存目录、本地多版本安装、周期检测或会话迁移框架。
