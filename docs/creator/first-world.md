# 制作第一张世界卡

目标：以最小「雾港来信」为基础，修改玩家身份和开场，检查文件，导入 SR 并开始一局。无需先写 React 组件。

先按[开始使用](../getting-started.md)完成依赖安装、启动和模型配置。下面的命令都在仓库根目录运行；需要 Node.js 22.19+ 和仓库指定的 pnpm。

## 1. 复制一份创作源

~~~sh
cp -R examples/worlds/minimal examples/worlds/my-first-world
~~~

如果目标目录已存在，换一个名称，保留原来的作品。打开 `examples/worlds/my-first-world/world.json`；这是接下来要编辑的源文件。最小示例可直接作为 JSON 导入，外置组件和包内素材则需要 ZIP。

先执行一次检查，确认环境可用：

~~~sh
pnpm world:check examples/worlds/my-first-world
~~~

**预期结果：**命令成功退出，JSON 报告的 `ok` 为 `true`。检查不调用模型，也不往你的运行数据库导入数据。

## 2. 改三个位置

在 `data.name` 中给作品起一个新名字，例如“雾港来信 · 我的第一版”。保持 `spec_version: "0.2"`、数组结构和角色/开局引用 ID；修改名称不需要修改这些引用。创建自己的作品时还应生成独立的 `publication.package_id`，填写实际作者署名、版本与说明，不能沿用示例作品身份；没有远端更新源时省略 update_url。详见[作者发行](world-publishing.md)。

在 `characters` 中找到 `id: "traveler"`。它的 `player_selectable: true` 表示玩家可扮演这一身份。把 `content` 改为：

~~~text
{{user}}是一名第一次到雾港的年轻送信人，手里只有一封未署名的信。
玩家决定自己的行动和对白。人物不知道信的收件人，也没有预先调查过灯塔。
~~~

在 `openings` 中找到 `id: "arrival"`，修改 `content`：

~~~text
渡轮停靠在雾港。你刚踏上码头，就发现信封边缘印着一座灯塔。
守灯人林舟提着风灯走来：“天快黑了。你是来找人，还是找路？”
~~~

**预期结果：**世界详情出现新名称；创建会话后显示你写的开场。这里的开场由卡片提供，创建会话本身不会向模型请求一段新开场。玩家随后发送行动，才开始模型续写。

`{{user}}` 指本次选中的角色名称，不是任意自定义变量。更详细的角色、世界书和变量用法见[组织世界内容](world-content.md)。

## 3. 再检查并打包

~~~sh
pnpm world:check examples/worlds/my-first-world
pnpm world:pack examples/worlds/my-first-world --out dist/worlds/my-first-world.zip
pnpm world:check dist/worlds/my-first-world.zip
~~~

打包仅纳入根 `world.json` 和 `components/`、`assets/`，README 等创作说明不进入资源包。输出 ZIP 已存在时，使用新的 `--out` 文件名，或确认它只是可重建产物后再自行移除。

**预期结果：**得到 `dist/worlds/my-first-world.zip`，且最终 ZIP 检查通过。最终包检查和目录检查都要成功，避免检查的是新源码，发出的却是旧压缩包。

## 4. 导入并玩一轮

1. 在世界库导入生成的 ZIP；也可导入最小示例的 `world.json`。
2. 打开新世界，选择“旅人”和“渡轮靠岸”，创建会话。选用已配置模型和「标准叙事」预设。
3. 确认第一条消息是刚写的开场，再输入：“我拿出信封，问林舟是否认识这个灯塔印记。”
4. 观察回复是否延续场景、尊重玩家决定权，并围绕信件与灯塔展开。

**预期结果：**可以正常流式收到叙事。具体台词和情节由模型生成，不要求逐字匹配示例。若输出跑偏，先修正人物设定和世界书中冲突的事实，再考虑更换模型或调整预设。

## 5. 只增加一项能力

第一轮跑通后，选择一个方向：

- [加入状态](state-and-rules.md)：记录银币、已知线索和当前任务。
- [增加角色或开局](world-content.md)：让同一个世界支持不同身份和起点。
- [加入状态面板与插图](presentation.md)：参考完整版的 TSX 和包内素材。
- [让 Agent 完成下一步](agent-authoring.md)：指定已有目录，要求保留原有设定并交付新 ZIP。

每次改变后，重新检查、打包并导入一份测试世界。不要把已有会话的数据当成新版本初始状态的验证结果。

## 常见卡点

| 现象 | 先检查什么 |
| --- | --- |
| JSON 报错 | 编辑器是否提示尾逗号、中文引号或缺失括号；看检查报告中的字段路径 |
| 没有可扮演角色 | 是否至少一项 `player_selectable` 为 `true` |
| 开局不显示新文字 | 是否导入了新文件、打开了新副本、创建了新会话 |
| 没有回复 | 模型配置和连接是否可用；会话是否选对模型 |
| 加图片后 JSON 无法导入 | 使用了 `sr-asset://` 或外置组件时改用 ZIP；见[打包与分享](packaging.md) |

下一步：[组织世界内容](world-content.md)。
