# 世界卡组件与展示权限

除下节注明的 V2 差异外，本文描述原 Studio/Server 的运行与展示契约。

## StudioV2 内容库边界

- V2 世界卡使用 `spec_version/data`；HTTP 管理详情使用顶层驼峰领域字段，不包含运行 state。已有文本 description 如实展示；新卡导入仍按组件描述协议校验。
- 世界内容库只读展示作者角色、开局、世界书及状态定义。世界详情沿用原 Studio 的折叠概览、角色条、六个图标 Tab、开局导航及弹窗。角色在头部选择并带入创建确认，弹窗允许选择配置；仅创建基础会话，不执行开局、不生成首条消息或应用 initial_state。
- 图片、音频、字体及组件文件来自 `/api/v1/worlds/:id/resources/*`；SDK 保留旧来源兼容，并支持 V2 资源根目录。
- 作者介绍与开局组件使用独立预览来源的 `world-component.html`，开发默认 127.0.0.1:5177；StudioV2 默认 127.0.0.1:5176。预览来源不得与管理来源相同。构建及部署配置见 [StudioV2 管理](../runtime/studio-v2-management.md)。
- 预览保留 sandbox、CSP、窗口/来源/nonce 校验。宿主只允许读取当前世界 global 路径，从状态响应 `data.item` 投影，不提供完整状态、写操作或会话能力。主题按 appearance 契约传递。组件错误局部展示并允许重试；离开或切换预览销毁旧文档与连接。
- 组件 path 优先，读取失败不回退 inline。世界管理不启动 Stage，不执行消息展示规则或状态规则。


世界卡保持 `spec / spec_version / data` 包装。组件相关字段位于 `data` 根层：

```json
{
  "stage_component": "WorldStage",
  "components": [
    { "id": "WorldIntroduction", "component": "export default function Introduction(){ return null; }" },
    { "id": "OpeningPreview", "component": "export default function Preview(){ return null; }" },
    { "id": "CGImage", "component": "export default function CGImage(props){ return null; }" },
    { "id": "WorldStage", "component": "import {SR} from '@sillyrealms/sdk'; export default function Stage(){ return <SR.WorldStory/>; }" }
  ],
  "description": { "type": "component", "component": "WorldIntroduction" },
  "openings": [{
    "id": "opening-1", "name": "开局 1", "content": "咚咚咚……",
    "initial_state": {}, "type": "component", "component": "OpeningPreview"
  }]
}
```

## 展示规则

- `components` 是共享源码库，组件 ID 唯一；仅支持 `@sillyrealms/sdk` 与世界卡内部 `./ID` 默认静态导入。旧 SDK 名称不兼容。
- `stage_component` 未指定或找不到目标时使用官方 `WorldStory`，其消息规则仍可引用共享组件库。目标存在但编译或执行失败时显示错误，不回退；平台不检查、插入或自动执行作者未使用的 `WorldStory`。
- `description` 可省略，指定时必须是有效组件引用，不接受旧字符串。介绍组件没有消息匹配参数。
- 开局的 `type`、`component` 成对提供，必须引用存在的组件。省略时只展示 `content` 的静态文本。预览组件与实际会话正文独立；图片、音频等由作者在预览源码中直接引用。
- `content` 按原文写入第一条 assistant 消息，不进行玩家占位符替换；`initial_state` 保持消息状态整项覆盖语义。开局预览及首条开局消息不执行 `message_render` 正则。后续普通消息照常执行规则。
- `message_render.rules[].replacement.component` 引用 `components[].id`。`CGImage` 若依赖 `groups`，只作为正则消息组件使用，不自动成为介绍或开局预览。
- 缺失引用在导入时拒绝（舞台允许找不到目标）；源码编译/运行错误在具体视图内显示重试，不阻止使用有效的其他入口。

角色选择位于头部角色列表：进入详情默认选中第一个可扮演角色，点击“可扮演”切换当前选择，选中项显示“已选中”及边框高亮。选择不持久化。开始会话弹窗显示当前开局名称和角色名称，只提供“取消”“确认开始”，弹窗内不能重新选择。

## 介绍与开局权限

两者从稳定的独立资源来源加载 `world-component.html`，使用 `sandbox="allow-scripts allow-same-origin"` iframe，只提供查询世界当前全局状态的能力：

```tsx
import React from 'react';
import {useSRWorldStateAPI} from '@sillyrealms/sdk';
export default function Preview() {
  const state = useSRWorldStateAPI();
  const [sky, setSky] = React.useState<string>('');
  React.useEffect(() => {
    let active = true;
    state.getState('weather.sky', 'global')
      .then(value => { if (active) setSky(String(value ?? '')); });
    return () => { active = false; };
  }, [state]);
  return <p>{sky}</p>;
}
```

`getState(path, scope?)` 默认 global；`batchGetState([{path,scope?}])` 返回对应查询值。没有事件订阅或隐式实时刷新。详情运行环境中的 `useSRStateAPI` 是相同只读 API 的别名；作者使用 `useSRWorldStateAPI` 可获得准确的只读类型。

禁止 session/message 状态、状态写入、Session API、事件订阅和直接 Server HTTP。权限由 Host 再次校验，不能靠伪造 iframe 请求绕过。组件不接收原始世界卡、状态定义、会话对象、凭据或底层 transport。`GET /api/v1/worlds/:id/state` 仅供可信 Host 查询当前 global 状态，再按路径返回结果给组件。初始消息状态查看器仍由平台 UI 提供，不能被预览组件读取。

iframe 使用 CSP `connect-src 'none'`，Server 拒绝来自该独立资源来源的 API 请求。切换页面/开局会销毁旧 iframe、终止未完成请求；媒体元素随文档销毁。安全的旧 prose 可使用 `WorldDocumentContent` 渲染在已有隔离文档中。

## 存储和兼容性

数据库 v5 将 `worlds.ui_json` 改名为 `components`，保存 JSON 数组；新增独立 `stage_component`，`description` 列保存引用对象的 JSON。领域、导入/导出和详情 API 使用同名公开字段，不兼容 `ui.source/ui.main` 输入。

## 会话图片与页面隔离

会话 Stage 使用稳定的独立来源，保留 sandbox 和原有 CSP。符合源站缓存条件的图片在重新进入会话和普通刷新时可复用浏览器缓存，无需修改世界卡图片地址。世界卡详情的介绍和开局组件也复用该独立资源来源，但保留单独的只读入口与权限校验；角色、世界书及无组件开局的静态文档保持原渲染方式。

舞台连接失败时显示重试入口。重试只重建舞台，保留平台输入草稿和已提交历史，不重新发送消息；已被服务端接受的生成继续按原生命周期处理。作者组件仍通过 SR SDK 访问当前会话，不能直接操作主界面或访问业务 HTTP。

## 详情切换与缓存

介绍、开局之间切换，离开详情再进入以及普通刷新时，符合源站缓存条件的图片可以复用浏览器 HTTP 缓存。媒体按浏览器及源站策略加载，不保证完整下载、离线使用或永久缓存。

同一应用运行期间，详情预览按世界 ID 和完整组件源码复用编译结果（包括进行中的编译），最多保留最近使用的 4 张世界卡。源码、组件 ID 或组件集合变化会重新编译；有编译错误或失败的结果不保留，以便重试。刷新应用会清空编译缓存。此缓存仅用于详情，不改变会话舞台的编译流程。

每次切换仍建立新文档，组件实例、局部状态、状态查询结果和音频播放不复用。原内容随切换清理，新预览重新读取需要的当前全局状态。加载失败保留重试入口，重试不会创建会话或发送消息。
