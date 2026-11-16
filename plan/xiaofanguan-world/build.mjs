/**
 * Rebuild the restaurant world from the committed, byte-exact source snapshot.
 * Run at the repository root: node plan/xiaofanguan-world/build.mjs
 * No database, provider, network, or ignored data/ files are required.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, 'package');
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const {ZipFile} = require('yazl');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const normalizeUser = text => text.replace(/\{\{user\}\}|<user>|\buser\b/g, '{{user}}');

const snapshot = await readFile(join(here, 'source/character-card.json'));
const provenance = JSON.parse(await readFile(join(here, 'source/provenance.json'), 'utf8'));
assert.equal(sha256(snapshot), provenance.sourceCard.metadataSha256, 'Original character-card snapshot changed');
const source = JSON.parse(snapshot);
assert.equal(source.spec, 'chara_card_v3');
assert.equal(source.spec_version, '3.0');
assert.equal(source.data.name, '小饭馆');
const original = source.data;
const entries = original.character_book.entries;
assert.deepEqual(entries.map(entry => entry.id), [0, 1, 2, 3, 4]);
assert(entries.every(entry => entry.enabled && entry.constant), 'Expected five enabled constant entries');
assert.equal(original.alternate_greetings.length, 2);
for (const field of ['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions']) {
  assert.equal(original[field], '', 'New source material requires an explicit mapping: ' + field);
}

const characterEntry = entries.find(entry => entry.id === 3);
const wrapper = /^<character>\r?\n([\s\S]*)<\/character>\r?\n?$/.exec(characterEntry.content);
assert(wrapper, 'Unexpected source character wrapper');
const splitAt = wrapper[1].indexOf('完整角色卡_李鸟儿:');
assert(splitAt > 0);
const characterBlocks = [wrapper[1].slice(0, splitAt), wrapper[1].slice(splitAt)];
assert(characterBlocks[0].startsWith('完整角色卡_李鱼儿:'));
assert(characterBlocks[1].startsWith('完整角色卡_李鸟儿:'));
assert.equal(characterBlocks.join(''), wrapper[1], 'Splitting must not drop source text');
const prompts = characterBlocks.map(block => '<character>\n' + normalizeUser(block) + '</character>\n');

const playerPrompt = '{{user}}是京城巷弄里小饭馆的掌柜，也是玩家扮演的角色。与李鱼儿、李鸟儿一起生活，三人彼此视作亲人。现在的日常是做菜、喝茶、买菜、记账与招呼食客。';
const openings = [
  {id: 'daily-opening', name: '小馆的一天', content: original.first_mes},
  {id: 'opening-keeper', name: '开门营业 · 掌柜', content: original.alternate_greetings[0]},
  {id: 'opening-boss', name: '开门营业 · 老板', content: original.alternate_greetings[1]},
];
const lore = entries.filter(entry => entry.id !== 3).map(entry => ({
  id: 'source-lore-' + entry.id,
  title: entry.comment,
  content: normalizeUser(entry.content),
  enabled: true,
  load: {mode: 'always', order: entry.insertion_order},
}));
const card = {
  spec: 'world_card',
  spec_version: '0.1',
  data: {
    name: original.name,
    description: {type: 'component', component: 'WorldIntroduction'},
    cover: 'sr-asset://assets/images/keeper.jpg',
    characters: [
      {
        id: 'user', name: '掌柜',
        description: '你所扮演的掌柜，在京城巷弄经营一间小饭馆。做菜、喝茶，与鱼儿、鸟儿一起照看这个家。',
        prompt: playerPrompt,
        avatar: 'sr-asset://assets/images/keeper.jpg',
        order: 0, player_selectable: true, load: {mode: 'always'},
      },
      {
        id: 'li-yuer', name: '李鱼儿',
        description: '姐姐，及笄之年。温婉而坚定，打理饭馆账目，也把家人的日子放在心上；闲时喜欢读书、练字。',
        prompt: prompts[0],
        avatar: 'sr-asset://assets/images/li-yuer.jpg',
        order: 1, player_selectable: false, load: {mode: 'always'},
      },
      {
        id: 'li-niaoer', name: '李鸟儿',
        description: '妹妹，及笄之年。外刚内柔，跑堂、试菜，熟悉街坊小贩；喜欢皮影戏，偷偷练女红，想给家人缝衣裳。',
        prompt: prompts[1],
        avatar: 'sr-asset://assets/images/li-niaoer.jpg',
        order: 2, player_selectable: false, load: {mode: 'always'},
      },
    ],
    openings,
    lorebook: {entries: lore},
    components: [
      {id: 'WorldIntroduction', path: 'sr-asset://components/WorldIntroduction.tsx'},
    ],
    extensions: {
      source: {
        format: source.spec,
        version: source.spec_version,
        name: original.name,
        lorebookName: original.extensions.world,
        pngSha256: provenance.sourceCard.sha256,
        metadataSha256: provenance.sourceCard.metadataSha256,
      },
      conversion: {
        version: 1,
        originalLoreEntryIds: entries.map(entry => entry.id),
        characterLoreEntryId: 3,
        userMacro: '{{user}}',
        openingText: 'verbatim',
      },
    },
  },
};
await writeFile(join(packageDir, 'world.json'), json(card));

const sourceMap = {
  schemaVersion: 1,
  source: provenance.sourceCard,
  title: {source: 'data.name', target: 'data.name', operation: 'verbatim'},
  player: {
    target: 'data.characters[id=user]',
    operation: 'derived_identity_summary',
    sourceEntries: [0, 2, 3, 4],
    note: '掌柜为唯一可选玩家；只增加角色分工说明，不增加原卡之外的年龄、数值或剧情。',
  },
  openings: openings.map((opening, index) => ({
    source: index === 0 ? 'data.first_mes' : 'data.alternate_greetings[' + (index - 1) + ']',
    target: 'data.openings[id=' + opening.id + '].content',
    name: opening.name,
    operation: 'verbatim_including_line_endings',
    characters: opening.content.length,
    sha256: sha256(opening.content),
    labelNote: '仅开局选择器标题为新增展示文案。',
  })),
  lore: entries.map(entry => ({
    source: 'data.character_book.entries[id=' + entry.id + ']',
    title: entry.comment,
    originalPosition: entry.position,
    originalOrder: entry.insertion_order,
    sourceContentSha256: sha256(entry.content),
    targets: entry.id === 3
      ? [
          {path: 'data.characters[id=li-yuer].prompt', contentSha256: sha256(prompts[0])},
          {path: 'data.characters[id=li-niaoer].prompt', contentSha256: sha256(prompts[1])},
        ]
      : [{path: 'data.lorebook.entries[id=source-lore-' + entry.id + '].content', contentSha256: sha256(normalizeUser(entry.content))}],
    operation: entry.id === 3 ? 'split_full_character_blocks_and_normalize_user_macro' : 'normalize_user_macro_only',
    activation: 'always',
  })),
  assets: provenance.assets,
  introduction: {
    ...provenance.introduction,
    target: 'components/WorldIntroduction.tsx',
    note: '保留既有介绍设计；React 使用编译器注入全局；useSRAssetUrl 解析离线头像；不注册旧 Portraits 数据对象为组件。',
  },
  runtime: {
    stage: 'official WorldStory (stage_component omitted)',
    state: 'omitted; original has no state or MVU',
    placement: 'SR persona.prompt / characters.prompts / world.lore; original ST before_char / after_char positions are documented, not emulated',
    playerMacro: 'One replacement pass converts {{user}}, <user>, and standalone user to {{user}} in prompts and lore only; openings stay verbatim.',
  },
  preservedSourceTensions: [
    '原文混用客栈与饭馆，角色提示词保留原字句；展示名称采用原卡小饭馆。',
    '日常绝不提往事的禁令与背景条目中必须情况下的条件性例外均保留；转换不改写原作者的叙事规则。',
    '李鸟儿护短中的冲突场景保留为原文性格举例，同时保留原文不得刻意安排此类插曲的约束。',
  ],
};
await writeFile(join(here, 'source-map.json'), json(sourceMap));

for (const asset of provenance.assets) {
  const bytes = await readFile(join(packageDir, asset.target));
  assert.equal(bytes.length, asset.bytes, 'Asset size changed: ' + asset.target);
  assert.equal(sha256(bytes), asset.sha256, 'Asset differs from existing source image: ' + asset.target);
}
async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    assert(!entry.isSymbolicLink(), 'Package must not contain symlinks');
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative + '/'));
    else {
      assert(entry.isFile(), 'Package must contain only regular files');
      files.push(relative);
    }
  }
  return files.sort();
}
const names = await listFiles(packageDir);
assert.deepEqual(names, [
  'assets/images/keeper.jpg',
  'assets/images/li-niaoer.jpg',
  'assets/images/li-yuer.jpg',
  'components/WorldIntroduction.tsx',
  'world.json',
]);
const zip = new ZipFile();
const chunks = [];
const finished = new Promise((resolve, reject) => {
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  zip.outputStream.on('end', resolve);
  zip.outputStream.on('error', reject);
  zip.on('error', reject);
});
const inventory = [];
for (const name of names) {
  const bytes = await readFile(join(packageDir, name));
  inventory.push({path: name, bytes: bytes.length, sha256: sha256(bytes)});
  zip.addBuffer(bytes, name, {
    // Fixed local date keeps DOS timestamp bytes stable across time zones.
    mtime: new Date(2026, 10, 16, 0, 0, 0),
    forceDosTimestamp: true,
    mode: 0o100644,
    compressionLevel: 9,
  });
}
zip.end();
await finished;
const archive = Buffer.concat(chunks);
await writeFile(join(here, '../xiaofanguan-world.zip'), archive);
const result = {
  artifact: 'plan/xiaofanguan-world.zip',
  bytes: archive.length,
  sha256: sha256(archive),
  entries: inventory,
  source: {pngSha256: provenance.sourceCard.sha256, metadataSha256: provenance.sourceCard.metadataSha256},
  content: {characters: 3, playerSelectable: ['user'], openings: 3, loreEntries: 4, fullNpcPrompts: 2, sourceLoreEntriesCovered: 5},
};
await writeFile(join(here, 'build-report.json'), json(result));
console.log(json(result));
