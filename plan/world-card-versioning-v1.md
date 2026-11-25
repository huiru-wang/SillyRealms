# SR 世界卡作者元信息、版本目录与覆盖更新方案

- 日期：2026-11-24
- 状态：待实施；本次仅保存方案，不修改业务代码。
- 仓库：/Users/wanghuiru/Workspace/SillyRealms
- 适用代码：当前 apps/server、apps/web、packages/sr-sdk。
- 本版按最新需求采用「同一世界原地覆盖指定版本」。不采用上一轮建议的多版本安装或 world_packages 分组。
- 集中托管发布与评论的独立补充方案见 [SR 世界卡集中发布与 Discord 评论方案](world-card-publishing-hub.md)；本地更新触发策略与覆盖语义保持本方案。

## 1. 已确定的产品范围

1. 世界卡正式增加 data.metadata，记录作品身份、作者、当前发行版与更新源。
2. 创作者提供一个固定 HTTPS 地址，返回该作品的完整公开版本目录。
3. 每个版本是一条数据对象，包含版本号、更新说明、发布时间和可直接下载的世界卡文件。
4. 每次服务启动，在完成本地初始化并开始监听后，后台异步执行一轮版本目录检查。
5. 世界列表、详情和版本列表接口只读取本地数据与检查缓存，不触发远端目录请求。
6. 将远端最新版本号持久保存；前端读取当前版本和最新版本，比较后显示一个红点。
7. 世界详情可以查看作者目录中所有公开版本，选择其中一个覆盖当前世界，包括升级和回退。
8. 覆盖保留本地 worldId、已有会话、历史消息、运行状态及本地管理配置；后续叙事与舞台使用覆盖后的作者内容。
9. 本期不增加定时检查、每次列表请求检查、详情打开补查、社区后台、增量下载、长期本地版本仓库或自动状态迁移。

「所有版本」指作者在目录中列出且仍公开提供的版本，并不保证找回作者已移除的历史发行。平台只保留一份当前安装，历史版在用户选中时重新下载。

### 1.1 严格启动一次的可见性边界

- 新导入的世界卡若错过本次启动扫描，等下次服务启动才检查；本期不偷偷增加单卡检查。
- 首屏早于后台检查完成时，读取上次缓存；从未检查过则显示未知。
- 已打开的静态列表不会因后台写库自行重绘；本期在下一次正常列表读取、重新进入或用户刷新页面后显示结果，不增加轮询或全局推送。
- 详情打开不会补拉目录；没有缓存时显示「尚未获取版本列表，服务启动时检查」。
- 用户主动应用某个版本时允许下载该版本文件。这是安装操作，不是再次检查版本目录。

这些限制是本期触发策略的直接结果。后续可以单独增加「手动检查」或「首次导入检查」，不包含在本期。

## 2. 当前代码依据

| 现状 | 源码位置 |
| --- | --- |
| 示例中仅有自由扩展 authoring.author / revision / notes | docs/world-card.json |
| 正式世界卡字段没有 metadata | apps/server/src/modules/worlds/validation.ts、types.ts |
| 作者扩展可以随导入/导出传递，但没有发布语义 | apps/server/src/modules/worlds/parser.ts |
| 普通导入创建新 UUID，并套用应用默认预设与模型 | apps/server/src/modules/worlds/service.ts、usecases/import-world.ts |
| 文件位于 dataRoot/worlds/<worldId>/source 与 package | apps/server/src/modules/worlds/files.ts |
| 现有发布函数拒绝覆盖已存在目标目录 | modules/worlds/files.ts 的 publishImport |
| 会话只保存 worldId，每轮读取当前世界定义 | modules/sessions/types.ts、usecases/context/capture.ts |
| global/session/message 状态分别存于 worlds/sessions/entries | infrastructure/database/connection.ts、modules/state/service.ts |
| 当前 RuntimeCache 只有 Run 占用，缺少世界覆盖占用 | infrastructure/cache/index.ts |
| 预览内容身份只看 worldId 和 components 声明 | apps/web/src/features/worlds/preview-cache.ts |
| 资源基地址不允许 query，资源响应缺少明确再验证规则 | packages/sr-sdk/src/asset-url.ts、apps/server/src/routes/worlds.ts |
| initialize 完成后才开始监听，适合监听后启动异步检查 | apps/server/src/server.ts、usecases/initialize.ts |

审阅时 DATABASE_VERSION 为 6，工作区有其他任务的未提交改动。实施时基于届时最新结构增加迁移，不写死与其他任务冲突的数据库版本，不清库、不覆盖其他任务文件。

## 3. 世界卡 metadata 结构

### 3.1 采用的结构

以下仅展示新增元信息和所在位置；角色、开局、状态、组件等现有字段沿用原协议。

```json
{
  "spec_version": "0.2",
  "data": {
    "name": "雾港纪事",
    "metadata": {
      "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
      "authors": [
        {
          "name": "雾灯",
          "url": "https://creator.example.org/"
        }
      ],
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
| authors | array | 至少一位作者，每项 name 为非空字符串，url 为可选 HTTP(S) 公开主页 |
| release.version | string | 正式新卡必填，稳定发行版本 MAJOR.MINOR.PATCH |
| release.published_at | string | 新发行必填，带时区的 ISO 8601 时间 |
| release.notes | string | 本版更新说明，可为空字符串；纯文本或受限 Markdown |
| homepage | string | 可选 HTTP(S) 地址，面向人的作品页面 |
| update_url | string | 可选，面向程序的固定公开 HTTPS 版本目录地址 |

- package_id 是作者作品身份，不能替代本机数据库 world.id；同作品可被用户独立导入多次。
- 作者署名不代表账号认证；不能凭作者昵称或作品名自动关联安装。
- authors[].url 和 homepage 只允许 HTTP(S)，拒绝 javascript:/data: 等协议；更新源和发行文件另按更严格的公开 HTTPS 规则校验。
- 二次创作成为独立发行作品时使用新的 package_id，可在说明中保留原作出处。
- release 只描述当前卡包的发行版；完整历史放在远端版本目录。
- metadata 不参与叙事提示词构建；本地更新检查结果不写入 metadata。
- 不增加 artifacts 到 metadata，避免将 ZIP 自身哈希放进被校验的 ZIP 引发自引用。

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
| metadata.release.version | 创作者 | 世界内容发行版本 |
| worlds.revision | SR 平台 | 本地管理/覆盖写入的 CAS 修订号 |

metadata 扩展随卡协议 0.2 发布。继续导入 0.1 卡，缺少 metadata 时作为未声明发行信息的离线卡。保留旧 extensions 原样，但不把 authoring.revision 猜成正式发行版本，也不按卡名自动补 package_id。

## 4. 创作者提供的全版本目录

### 4.1 目录地址

metadata.update_url 指向固定的原始 JSON，例如：

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
| package_id | 必须与本地 metadata.package_id 相同 |
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

用于远端覆盖的发行文件必须带正式 metadata，本期对应卡协议 0.2。支持普通导入旧 0.1 卡，不代表无发行身份的旧卡可以成为可应用版本；此类条目在详情禁用，不能下载后才尝试猜测作品身份。

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

## 5. 本地存储：两个 JSON 字段即可

在 worlds 增加：

| 列 | 内容 | 是否导出 |
| --- | --- | --- |
| metadata_json | 正式作者/发行 metadata；旧卡允许 NULL | 是 |
| update_cache_json | 绑定来源、完整目录、latestVersion、检查时间和结果 | 否 |

不再额外双写 author、version、latest_version、checked_at 等独立列，不新增版本表、作品分组表或通用任务表。

### 5.1 缓存领域结构

以下为服务端内部类型示意，使用驼峰命名；其中 manifest 保持作者协议原字段。

```ts
type WorldUpdateCache = {
  source: {
    packageId: string;
    updateUrl: string;
  };
  status: "checking" | "ready" | "failed";
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  latestVersion: string | null;
  manifest: WorldVersionIndex | null;
  errorCode: string | null;
};
```

- 缓存绑定 packageId + updateUrl，不是仅绑定显示名称。
- 开始检查时保留 manifest/latestVersion/lastSuccessAt，只更新状态和本次尝试时间。
- 成功时在一次本域写入中替换完整目录、latestVersion 与成功时间。
- 失败时保存失败状态与简明错误码，保留上次成功目录和 latestVersion。
- NULL 表示尚未建立缓存，不能解释为「已是最新版」。
- 列表读取时，缓存来源若与当前绑定不一致，则视为无缓存，不能拿旧源数据比较。
- 缓存检查不递增 worlds.revision，不修改作者内容，不改变 createdAt/updatedAt，也不影响列表排序或预览缓存。
- 导出继续从世界作者内容和资源构建，严格排除 update_cache_json。

## 6. 服务启动后的单次后台检查

### 6.1 生命周期

1. 按现有顺序打开数据库、装配服务并完成 initialize，包括缺失内置卡的导入。
2. HTTP 开始监听。
3. 启动一次后台 Promise，截取当时已存在且有合法 metadata.update_url 的世界卡列表。
4. 每张卡获取一份目录，校验并保存缓存。
5. 本轮结束；进程存活期间不再自动启动下一轮。

任务不阻塞服务可用，不让远端失败导致服务启动失败，不递归调用自己，不设置周期定时器。

同一批内可按 package_id + update_url 合并重复请求，再分别回写对应 worldId；这是一次批次内的请求去重，不增加长期服务。

建议并发数 3，目录单次请求超时 10 秒、正文上限 2 MiB、最多 1000 个版本、重定向上限 3。超限按检查失败处理，不截断目录。具体值集中定义并可在实施时按现有规范调整。

### 6.2 异步结果回写条件

请求前捕获：

```text
worldId + packageId + updateUrl
```

请求完成后确认 world 仍存在、作品与来源绑定未变，再写缓存；否则丢弃。

- 仅本地安装 version 变了，不必丢弃同源索引；前端会以新本地版本重新比较。
- 管理名称、标签、模型变化也不让同源检查结果失效。
- 删除世界后不允许后台结果重新创建世界。
- 应用任意版本保留已绑定更新源，见第 9.3 节。

### 6.3 关闭与失败

- 关闭服务时取消未完成网络请求，并让检查 Promise 在关闭数据库前结束。
- 每张卡失败独立记录，不能中断整批。
- 不自动重试，不引入持久队列或执行恢复。
- 有旧成功缓存时仍可展示它，但详情标出上次成功时间和本次失败。
- 单纯检查成功没有 world.updated 事件；该事件只用于实际覆盖后的会话同步。

## 7. 世界列表：前端比较并显示一个红点

### 7.1 列表返回投影

在现有摘要字段之外增加：

```ts
type WorldVersionSummary = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateStatus: "no_source" | "not_checked" | "checking" | "ready" | "failed";
};
```

- currentVersion 来自 metadata.release.version。
- latestVersion 来自匹配来源的 update_cache_json。
- no_source / not_checked 根据 metadata 与缓存推导，不要求持久存储这两个状态。
- 列表不携带完整版本目录，不在 route 中发起远端请求。
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

不为红点单独添加 SSE、定时检查或前端轮询。只要前端再次正常读取列表，就可看到后台完成后保存的结果。

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

- 已有缓存：直接展示缓存的完整目录，并显示最后成功检查时间。
- 检查中：可继续展示上次成功目录，附「本次启动正在检查」。
- 失败：继续展示旧目录与上次成功时间，附简短失败说明。
- 首次未完成或新卡尚未检查：显示空态与启动检查规则。
- 未配置更新源：显示「作者未提供版本目录」。
- 当前安装版已不在远端目录中：仍展示当前版本摘要，但不伪造其下载记录。

打开弹窗只查询本地缓存。这里的目录是最近一次启动所取得的公开版本列表，不声称实时更新。

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
- 用户设置的世界名称、标签、默认预设与默认模型。
- 当前绑定的更新源和已有同源版本目录缓存。

目标版本覆盖：

- 介绍、封面、角色、开局、世界书。
- 状态定义、消息渲染规则。
- 组件、舞台入口、作者扩展。
- 作者信息、发行版本、发行说明等 metadata。

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
- 保留同源 update_cache_json，因此回退后仍知道远端最新版本。
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

### 10.1 准备阶段

1. 读取当前世界、匹配来源的缓存及用户选定的版本记录。
2. 验证 expectedRevision 和 expectedSha256，拒绝目录已变化或同版本操作。
3. 若已知该世界正在运行，可提前拒绝以避免无效下载。
4. 从缓存记录取得 URL；不接受前端任意传入下载 URL。
5. 在临时目录下载，检查格式、实际大小和 SHA-256。
6. 复用现有解析、ZIP 路径/资源校验及卡协议验证。
7. 确认包内身份与目标版本一致，得到待提交作者内容。

网络和解包阶段不持有世界更新占用。文件暂存失败只清本次暂存。

### 10.2 最后应用阶段

1. 获取目标 worldId 的短暂更新占用；拒绝同世界活跃 Run 或其他覆盖。
2. 重新读取当前世界，复核 expectedRevision、来源和目标记录。
3. 检查会话玩家角色及需保留的状态定义兼容。
4. 将旧目录暂移到本次操作的临时备份位置，再将新目录发布到原位置。
5. 在短同步数据库事务中 CAS 更新作者内容和 metadata，revision 加一；不写运行 state 和本地保留字段。
6. 数据库成功后清理临时旧目录，释放占用，再发提交后事件。
7. 返回最新世界详情。

文件/数据库通过暂存和补偿协调，沿用当前仓库原则，不宣称跨文件与数据库的强事务。

普通失败时恢复旧目录并回滚数据库；回滚失败必须给出明确清理/恢复错误，不能假装更新成功。DB 已提交后的临时旧目录清理失败不再把已生效更新当作未完成，应记录清理信息并保留成功结果。

临时备份仅服务本次替换失败补偿，不是长期历史版本。

### 10.3 必须区分导入与替换的文件能力

- 复用 stageImport 和 readImportPackage 的准备/校验能力。
- 现有 publishImport 拒绝已存在目标，新增明确的替换发布方法。
- 现有 discardImport 在 published 分支可能删除整个目标目录，不能直接拿来补偿覆盖。
- 原件和 package 一并切换，确保「下载原件」对应当前安装。
- 替换整个 package，不能只将新文件覆盖到旧目录，否则新版已删除文件会残留。
- 删除、导入发布等写操作复用现有文件串行机制；现有导出并没有被该机制串行保护，不能假定它已安全。
- 导出、组件批量读取和单资源打开，在开始与返回前复核更新占用和捕获的 revision。若覆盖发生，丢弃本次构建结果或关闭已打开流，返回可重试错误，避免交付旧 JSON 加新资源。
- 完成且通过复核的导出临时 ZIP 可独立流式发送；单资源流使用其打开时对应的验证标识，不能给旧流挂上新版 ETag。无需为此引入通用读写锁。

## 11. 运行锁与已打开页面

### 11.1 只扩展现有内存 RuntimeCache

新增轻量 world 更新占用，不新增持久锁、分布式锁、后台执行框架。

占用期间：

- 同世界新的 Run 不能开始。
- 不能创建该世界的新会话。
- 不能对该世界关联的 global/session/message 状态或会话执行冲突写入。
- 阻挡第二次覆盖、删除和管理写入。
- 世界详情、组件和资源在短暂替换窗口不能读到 DB/文件混合版本，可返回明确的正在更新结果。
- 其他世界、已有历史读取与停止操作保持现有行为。

只在替换前检查「当前无 Run」不足够：文件 await 期间新 Run 可能开始。因此 acquireRun、会话创建及相应写入口也必须识别世界更新占用。

RuntimeCache 不查询数据库；调用方提供世界归属。内部覆盖 permit 只在服务端持有，不通过 HTTP/SDK 传播。

### 11.2 详情预览失效

previewContentIdentity 增加 metadata.release.version；更新版本改变，即销毁原预览池、取消旧源码请求、重建桥接并读取新源码。

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
- 不新增全局 SSE，不对启动版本检查发送该事件，不将更新目录作为会话事件传输。

## 12. HTTP / Web 契约

统一 /api/v1 前缀和现有成功/错误包络，以下路径省略前缀。

| 接口 | 行为 |
| --- | --- |
| GET /worlds | 本地摘要，增加 currentVersion/latestVersion/updateStatus；零远端调用 |
| GET /worlds/:id | 当前作者内容和 metadata，提供精简检查状态；零远端调用 |
| GET /worlds/:id/versions | 返回缓存版本目录、当前版、最新版和检查时间/结果；零远端调用 |
| POST /worlds/:id/apply-version | 依据缓存版本记录下载并覆盖当前世界 |

本期不公开 check-update/refresh 接口，避免与「只启动自动检查一次」混淆。

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

本节描述创作者自行维护发行源的流程。采用 [集中发布方案](world-card-publishing-hub.md) 时，固定地址、最终包存储、哈希及版本目录由发布中心生成，创作者只需上传卡包和填写版本说明；公开协议保持一致。

### 13.1 首次准备

1. 创建世界源码目录，沿用 world.json、components/、assets/ 布局。
2. 生成一次 package_id 并写入源文件，之后不随打包重新生成。
3. 填写 authors、homepage 和固定 update_url。
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
4. 生成包含新 metadata 的 ZIP，计算最终 ZIP 的 sha256 和 size_bytes。
5. 将发行对象追加到本地 releases.json，保留旧发行对象。
6. 先上传新 ZIP 到固定版本路径，确认可直接下载。
7. 再上传覆盖固定 releases.json。
8. 用户下次启动 SR 后获得新的目录缓存，世界列表按版本差显示红点。

不先公布目录再上传文件；不把旧版本下载链接统一重定向到最新 ZIP；不使用 latest.zip 作为每个历史版本的共同下载目标。

### 13.3 发行脚本的职责

拟新增 scripts/release-world.ts 与 pnpm world:release 命令；以下是实施后的目标用法，本轮尚未实现：

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
- 读取 notes，按同一份发行数据生成包内 metadata.release 和目录记录。
- 发布时间缺省使用实际打包时间，可显式指定用于可复现发布。
- 复用正式卡片/资源校验，不维护另一套弱校验器。
- 输出版本 ZIP、最终哈希、大小和更新后的 releases.json。
- 同版本记录已存在则拒绝覆盖，要求新版本号。
- 本期只生成发布文件，不集成上传凭据、不自动推送到外部托管。

已有不超过上传限制的 JSON 卡也可由同一协议发行；包含离线媒体的世界统一推荐 ZIP。

### 13.4 作者需要提供给玩家什么

首次分享时提供当前 ZIP，或提供其直接下载链接。ZIP 内 metadata.update_url 已包含固定版本目录地址，玩家导入后无需再填写一套订阅配置。

作品主页面向人；update_url 面向程序；artifact.url 面向某一版实际文件。三种链接职责清楚，不要求作者建设额外产品网站。

## 14. 文件改动范围

以下是实施目录树；[新增]/[修改]/[删除] 表示计划范围，不代表本轮已经改代码。

```text
/Users/wanghuiru/Workspace/SillyRealms/
├── apps/server/src/
│   ├── server.ts                              [修改] 监听后单次检查与关闭取消
│   ├── services.ts / usecases.ts / app.ts      [修改] 装配读取/覆盖用例
│   ├── errors.ts                              [修改] 集中更新相关错误
│   ├── infrastructure/
│   │   ├── database/connection.ts             [修改] 两列 JSON 及结构迁移
│   │   └── cache/index.ts                     [修改] 短暂世界覆盖占用
│   ├── modules/worlds/
│   │   ├── types.ts                          [修改] metadata/缓存/摘要领域类型
│   │   ├── validation.ts / parser.ts         [修改] 0.2/0.1 解析与导入导出
│   │   ├── releases.ts                       [新增] 目录校验与版本索引规则
│   │   ├── downloads.ts                      [新增] 受限目录/发行文件获取
│   │   ├── update-validation.ts              [新增] 玩家引用及状态兼容检查
│   │   ├── repository.ts / service.ts        [修改] 缓存写入与 CAS 内容覆盖
│   │   └── files.ts / assets.ts              [修改] 替换补偿及资源验证元信息
│   ├── modules/sessions/service.ts            [修改] 写入口识别世界覆盖占用
│   ├── usecases/
│   │   ├── check-world-versions.ts            [新增] 启动单批扫描
│   │   ├── apply-world-version.ts             [新增] 指定发行版覆盖编排
│   │   ├── import-world.ts / export-world.ts  [修改] 元信息贯通，缓存不导出
│   │   ├── create-session.ts / set-state.ts   [修改] 覆盖期写入互斥
│   │   └── delete-world.ts                    [修改] 删除与覆盖互斥
│   └── routes/worlds.ts                       [修改] 本地版本接口与资源再验证
├── apps/web/src/
│   ├── features/worlds/
│   │   ├── api/worlds.ts                      [修改] 版本信息与覆盖接口
│   │   ├── WorldCard.tsx / WorldLibraryPage.tsx[修改] 版本比较及红点
│   │   ├── WorldDetailPage.tsx                [修改] 作者版本入口与覆盖后刷新
│   │   ├── WorldVersionsDialog.tsx            [新增] 全版本说明/选择/确认
│   │   └── preview-cache.ts / WorldComponentCache.tsx
│   │                                         [修改] 发行版本变化重建预览
│   ├── features/sessions/workspace.ts         [修改] 更新后/重连后重载世界内容
│   ├── features/sessions/SessionPage.tsx       [修改] 发行版本变化时重建舞台，保留 workspace
│   ├── transport/session-events.ts            [修改] 分发 world.updated
│   ├── app/ManagementData.tsx                 [修改] 覆盖后刷新摘要
│   └── i18n/locales/                          [修改] 跟随当前中英日文案体系
├── packages/sr-sdk/
│   ├── src/release-version.ts                 [新增] 前后端共享稳定版本比较
│   ├── src/stage-contract.ts                  [修改] 会话事件类型
│   └── package.json                          [修改] 导出纯版本比较子路径
├── scripts/release-world.ts                   [新增] 发行产物及目录生成
├── package.json                              [修改] 发行脚本命令
├── docs/
│   ├── world-card.json                        [修改] 正式 metadata 示例
│   ├── creator/world-publishing.md            [新增] 作者发布与链接说明
│   ├── runtime/server-http.md                 [修改] 列表/版本/覆盖契约
│   ├── runtime/server-events.md               [修改] 提交后世界更新通知
│   └── runtime/web-management.md / web-runtime.md
│                                             [修改] 红点/覆盖/舞台刷新行为
└── plan/world-card-versioning-v1.md           [新增] 本方案
```

删除文件：无。对应模块函数测试按下节增加或修改，不因本功能重构 context/state 常规算法、资源寻址协议或整个管理页面。

单域知识放 worlds，通过 service.ts 对外；网络/文件/DB多步骤编排归 usecases。检查缓存更新属于 worlds 本域，不能由 routes 直接写 SQL。

## 15. 实施顺序与验收

### 第一步：协议和本地投影

- 0.2 metadata、0.1 卡兼容、两个 JSON 列。
- 导入导出保留 metadata 且不带检查缓存。
- 全版本目录校验与共享版本比较。
- 列表/详情的本地字段投影。

### 第二步：启动检查和版本展示

- 单次异步批次、失败保留缓存、来源绑定回写。
- 列表红点、版本详情与未知/失败状态。
- 不在列表/详情/导入流程增加远端检查。

### 第三步：指定版本覆盖

- 复用导入准备，完成同 worldId 文件替换与 CAS 提交。
- 运行状态/本地配置保留及明确兼容门槛。
- 短暂世界占用、预览失效、资源再验证、已打开会话刷新。

### 第四步：创作者发布工具与说明

- 从一份发行信息生成 ZIP、哈希、大小和完整目录。
- 文档提供可复制的字段、链接形态、发布顺序与失败排查。

### 必要验收场景

1. 1.10.0 大于 1.9.0；非法/预发行版本不混入本期排序。
2. 单次启动每个来源最多检查一次；首次页面请求与重复页面请求都不新增目录 GET。
3. 服务已可用时检查仍可进行；远端失败不影响启动；关闭后无晚到数据库写入。
4. 失败保留上次目录和 latestVersion；没有缓存不假装最新版。
5. 来源变化、世界删除后的晚到结果被丢弃。
6. 新导入卡明确等下次启动；启动首屏读取时序符合第 1.1 节。
7. 查看说明不消红点，升级后消失，回退后重新出现。
8. 同名不同 package_id 拒绝应用；重复版本/同版哈希变更拒绝目录。
9. ZIP/JSON 下载失败、哈希不符、解包或 DB 失败时当前内容保持或恢复。
10. 覆盖不改变世界 ID、消息、三 scope 状态、默认模型/预设和本地管理字段。
11. 缺少已有玩家角色、状态根/类型不兼容、范围收紧时在替换前拒绝。
12. 下载期间可正常运行；最终覆盖与新 Run/会话/状态写入互斥，其他世界不受影响。
13. 同路径组件替换后重新获取，资源不沿用旧验证标识；管理名称变化不重建预览。覆盖前已开始的导出/组件读取若横跨替换，结果被丢弃而非交付混合包。
14. 已打开会话能通过 sessionId 校验接收 world.updated，发行版本变化重建舞台；断线重连可补查，输入草稿和历史保持。
15. 回退不改变 update_url；目录/源未变时缓存保持有效。
16. 发行脚本给出真实 SHA-256 与大小，同版重复发布被拒绝。

按仓库现有约束，实施阶段先用函数级测试、临时目录/临时库、typecheck/lint 验证；不启动真实服务、不触碰真实凭据。此次仅文档保存，验证文档结构、示例 JSON 和写入路径即可。

## 16. 参考与设计来源

本方案的外部机制参考沿用本轮对话已核对的一手资料；字段和首版取舍是 SR 自身设计，不是声称行业存在完全相同标准。

- Foundry 模块清单中的稳定 manifest、下载 ZIP 与版本：https://foundryvtt.com/article/module-development/
- Foundry 发行记录与更新说明：https://foundryvtt.com/article/package-management/
- SillyTavern 作者与角色版本元信息：https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- Character Card V2 将格式版本与内容版本分开：https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md

本方案正式收口为：metadata + 全版本目录 + 启动一次缓存 + 前端红点 + 同 worldId 覆盖。没有增加本地多版本安装、周期检测或会话迁移框架。
