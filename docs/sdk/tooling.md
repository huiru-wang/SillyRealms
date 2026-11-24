# 包子路径与校验工具

[开发手册目录](README.md)。本章面向开发世界卡检查器、打包器和 Web 宿主的开发者或 Agent。以下是当前 workspace 包在 `package.json` 中另外导出的五个子路径。仓库工具可在支持 TypeScript 源码的环境里导入；世界卡 TSX 的模块加载器只注入 SDK 包根。请把这些调用放在打包或宿主代码里。

## 先使用仓库创作命令

在仓库根运行 `pnpm world:check <目录|json|zip>` 检查结构、资源与组件依赖；运行 `pnpm world:pack <目录> [--out <zip>]` 构建并检查最终 ZIP。成功退出 0，失败非 0；输出为 JSON 报告。默认 ZIP 写在源码目录同级，已存在时拒绝覆盖，可通过 `--out` 另存。检查不执行组件、不验证远程 URL、不调用模型。具体操作见[打包与分享](../creator/packaging.md)，工具回归测试为 `pnpm test:world-cards`。

只有要编写自己的检查器或宿主集成时，才需要继续使用下面的包子路径；卡内组件仍只导入 SDK 包根。

## @sillyrealms/sdk/assets

`PackageRoot` 为 `'assets' | 'components'`。函数均为同步纯函数，非法输入抛出 Error。示例中的 `base` 来自宿主，值形如 `https://reader.example/api/v1/worlds/inn/resources/`。

| API | 调用示例 | 结果与限制 |
| --- | --- | --- |
| `validatePackagePath(path, root?)` | `validatePackagePath('assets/门牌.png', 'assets')` | 返回已验证的原始字符串。路径相对于包根，拒绝绝对路径、空段、点段、反斜线、百分号、保留设备名等。提供 root 后须位于该分类下；路径总长最多 4096 UTF-8 字节，单段最多 255。 |
| `parseSRAssetUri(uri, root?)` | `parseSRAssetUri('sr-asset://components/InnStage.tsx', 'components')` | 返回 `components/InnStage.tsx`。省略 root 时也只接受 assets 或 components。输入保持原始路径，不预先 URL 编码。 |
| `parseSRAssetBaseUrl(value)` | `const origin = parseSRAssetBaseUrl(base).origin;` | 返回 URL 对象；接受 HTTP(S) 世界资源端点及末尾斜杠，拒绝凭据、查询串和片段。 |
| `resolveSRAssetUrl(uri, assetBaseUrl)` | `resolveSRAssetUrl('sr-asset://assets/门牌.png', base)` | 包内图片得到以 base 为根、逐段编码的 URL；null/undefined 输入返回 null。包内 URI 只接受 assets，缺失基址会报错。绝对 HTTP(S) URL 可独立解析。 |

## @sillyrealms/sdk/state-validation

这些函数检查输入并在失败时抛出 `StateValidationError`。除 `isSafeStateKey` 外，验证函数成功时返回 void，并为 TypeScript 缩窄类型。下面的 `coins` 是贯穿本节的定义。

```ts
import {
  validateStateSchema, validateStateSnapshot, validateStateValue,
  StateValidationError, type StateDefinition, type StateSchema,
} from '@sillyrealms/sdk/state-validation';

const coins: StateDefinition = {type: 'number', initial: 10, min: 0, description: '随身银钱'};
const schema: StateSchema = {schema_version: 2, scopes: {message: {coins}}};
validateStateSchema(schema);
validateStateSnapshot({coins}, {coins: 8}, 'message');
try {
  validateStateValue(coins, -1, 'coins');
} catch (e) {
  if (e instanceof StateValidationError) console.warn(e.details);
  else throw e;
}
```

| API | 调用示例 | 校验范围与注意事项 |
| --- | --- | --- |
| `isSafeStateKey(key)` | `isSafeStateKey('coins')` → true | 验证单个字符串键。空串、含点号或方括号的键与原型相关保留名返回 false。完整点路径需逐段检查。 |
| `validateStateJson(value, depth?, scope?, path?)` | `validateStateJson({bag: ['茶叶']})` | 根深度默认 0，验证 JSON 值、有限数字、对象键与深度。单独调用不执行字节大小校验。可传 scope、path 以定位错误。 |
| `validateStateValue(definition, value, root, scope?)` | `validateStateValue(coins, 8, 'coins')` | 校验完整根值、类型、数值上下界、JSON 合法性及大小。更新嵌套字段时应先构造新的完整根值。默认 scope 为 message。 |
| `validateStateDefinition(root, definition, scope?, source?)` | `validateStateDefinition('coins', coins, 'message', 'author')` | 验证单条定义的初值、描述、类型、范围、可选 rules 和 load。作者数据使用默认 author；stored 模式用于兼容已存 rules。`load.when` 的表达式语法另用 `validateWhen` 校验。 |
| `validateStateSchema(value, source?)` | `validateStateSchema(schema, 'author')` | 检查 `schema_version: 2`、合法 scopes、每个根定义与整体大小。输入是卡片的 `data.state`，不是整张卡。 |
| `validateStateSnapshot(definitions, value, scope?)` | `validateStateSnapshot({coins}, {coins: 5}, 'message')` | 当前快照必须恰好包含该域声明的所有根，逐根验证值。这里传完整字典，不能传 PATCH 更新数组。 |
| `StateValidationError(code, scope?, path?, rulePath?)` | `new StateValidationError('INVALID_STATE_PATH', 'message', 'coins')` | 可捕获或创建明确诊断。读取 `code/scope/path/rulePath` 或 `details`；缺省 scope 为 message，path 为空。 |
| `STATE_MAX_BYTES`、`STATE_MAX_DEPTH` | `const limits = {bytes: STATE_MAX_BYTES, depth: STATE_MAX_DEPTH};` | 分别为 1048576 与 32。大小按序列化 JSON 的 UTF-8 字节计；根深度为 0。 |

类型 `Json` 表达 JSON 值，`StateScope` 表达作用域，`StateSchema` 含版本和各域，`StateDefinition` 含 type、initial、description，可带 rules、min/max、load。`StateValidationCode` 是诊断码联合类型，`StateDiagnostic` 描述 code、scope、path 和可选 rulePath。`rules` 可以省略；提供的条目需要合法路径与非空文本，不要求覆盖全部状态。`on_mention` 需要非空关键词。[定义与验证源码](../../packages/sr-sdk/src/state-validation.ts)

## @sillyrealms/sdk/when-expression

`validateWhen(input, onReference?): void` 做语法验证。成功时可通过回调收集 `WhenStateReference`，其中 `path` 是字符串段数组，`scope` 是显式作用域，省略时为 null。解析错误或不支持的表达式会抛出异常。检查引用是否真的存在，应由调用方结合当前卡片定义完成。

```ts
import { validateWhen, type WhenStateReference } from '@sillyrealms/sdk/when-expression';

const refs: WhenStateReference[] = [];
validateWhen('getState("coins", {scope: "message"}) >= 5', ref => refs.push(ref));
// refs[0] 对应 {path: ['coins'], scope: 'message'}
```

允许字符串、数字、布尔、null 字面量，`! + -` 一元运算，严格相等、不等、大小比较、算术、`&& || ??` 和三元表达式。函数调用只允许 `getState`，路径可用字符串或字符串字面量数组。表达式最多 4096 UTF-8 字节、256 个受检节点，引用路径最多 32 段。该函数不读取状态，也不计算条件真假。

## @sillyrealms/sdk/world-document

此子路径导出供浏览器宿主使用的 `WorldDocumentRenderer`。必填 `content: string`，可选 `title`（默认“文档”）、`presentation`（默认 isolated）、`density`（默认 reading）、`className` 和 `showStyleWarning`（默认 true）。isolated 用隔离 iframe 展示文档，可提示被移除的样式；inline 使用消息级清洗并接受 `density="chat"`。组件使用浏览器 DOM。Stage 内应从包根导入同名组件，包根版本仅接受 content、density、className。

```tsx
import React from 'react';
import { WorldDocumentRenderer } from '@sillyrealms/sdk/world-document';

export default function HostPreview() {
  return <WorldDocumentRenderer content="# 旅店手册" title="旅店手册预览"
    presentation="isolated" density="reading" showStyleWarning />;
}
```

## @sillyrealms/sdk/world-story.css

宿主构建时用静态导入 `import '@sillyrealms/sdk/world-story.css';` 提供官方正文样式。当前会话 frame 已加载此样式，卡内直接渲染 `<SR.WorldStory />` 即可。本子路径是样式文件，没有 JavaScript 函数或返回值。

全部公开子路径见[包导出表](../../packages/sr-sdk/package.json)，卡内模块允许列表见[组件编译规则](../../packages/sr-ui-compiler/src/modules.ts)。
