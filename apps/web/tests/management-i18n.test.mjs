import {test} from 'node:test';
import assert from 'node:assert/strict';
import {i18n} from '../src/i18n/instance.ts';
import {cacheDuration, modelDraft, modelDraftError, modelFacts} from '../src/features/models/catalog.ts';
import {connectionTestError} from '../src/features/models/connection-test.ts';
import {samplingFields, samplingError} from '../src/features/presets/sampling.ts';
import {initialValueChildren, initialValueText} from '../src/features/worlds/initial-state-values.ts';
import {stateDescriptionLabel} from '../src/features/worlds/state-description.ts';

test('management labels follow live language changes while author names, values and paths remain literal', async () => {
  const authorText = '暂无字段';
  const saved = {id:'saved',name:'我的模型',providerId:'provider',modelId:'原始-model-id'};
  const array = {key:'背包',path:'背包',value:[authorText]};
  const model = {contextWindow:131072,maxTokens:8192,reasoning:true,input:['text','image'],api:'openai-completions',thinkingLevels:['low','high']};
  const temperature = samplingFields.find(field=>field.key==='temperature');
  try {
    await i18n.changeLanguage('en');
    assert.equal(cacheDuration(60),'1 minute');
    assert.equal(cacheDuration(120),'2 minutes');
    assert.equal(temperature.label,'Temperature');
    assert.equal(samplingError(temperature,3),'Temperature must be between 0 and 2.');
    assert.equal(modelDraftError(modelDraft(),null),'Enter a connection name.');
    assert.equal(modelFacts(model).find(fact=>fact.field==='contextWindow').value,'131,072 tokens');
    assert.equal(modelFacts(model).find(fact=>fact.field==='reasoning').value,'Supported');
    assert.equal(initialValueText(null),'Not determined');
    assert.equal(initialValueText(authorText),authorText);
    assert.deepEqual(initialValueChildren(array),[{key:'Item 1',path:'背包[0]',value:authorText}]);
    assert.equal(stateDescriptionLabel({key:'[]'}),'Each item');
    assert.equal(stateDescriptionLabel({key:'金币'}),'金币');
    assert.equal(modelDraft(saved).name,'我的模型');
    assert.equal(modelDraft(saved).modelId,'原始-model-id');

    const failure=Object.assign(new Error('服务端原始诊断'),{errorCode:'PROVIDER_ERROR'});
    assert.doesNotMatch(connectionTestError(failure),/[\u4e00-\u9fff]/);
    assert.match(connectionTestError(failure),/PROVIDER_ERROR/);
    await i18n.changeLanguage('zh-CN');
    assert.equal(cacheDuration(60),'1 分钟');
    assert.equal(temperature.label,'温度');
    assert.equal(initialValueChildren(array)[0].key,'第 1 项');
    assert.equal(initialValueText(authorText),authorText);
  } finally {
    await i18n.changeLanguage('zh-CN');
  }
});

test('Japanese management labels and errors update live without translating author data', async () => {
  // Capture the field and error before switching so this checks retained state.
  const frequency = samplingFields.find(field=>field.key==='frequencyPenalty');
  const failure = Object.assign(new Error('server raw diagnostic fixture'),{errorCode:'PROVIDER_ERROR'});
  const authorTexts = ['暂无字段','No fields','フィールドなし'];
  const array = {key:'背包',path:'背包',value:authorTexts};
  const saved = {id:'saved',name:'私の模型 — my model',providerId:'provider',modelId:'作者-model-id'};
  const model = {contextWindow:131072,maxTokens:8192,reasoning:true,input:['text','image'],api:'openai-completions',thinkingLevels:['low','high']};
  assert.ok(frequency);
  try {
    await i18n.changeLanguage('en');
    assert.equal(frequency.label,'Frequency penalty');
    const englishFailure = connectionTestError(failure);

    await i18n.changeLanguage('ja');
    assert.equal(i18n.resolvedLanguage,'ja');
    for (const namespace of ['worlds','presets','models']) {
      assert.equal(i18n.hasResourceBundle('ja',namespace),true);
    }
    assert.equal(cacheDuration(60),'1分');
    assert.equal(cacheDuration(120),'2分');
    assert.equal(cacheDuration(86400),'1日');
    assert.equal(frequency.label,'頻度ペナルティ');
    assert.equal(frequency.help,'正の値は単語の繰り返しを抑えます。同じ単語を使う回数が多いほど、強く抑制します。');
    assert.equal(samplingError(frequency,3),'頻度ペナルティは-2から2の範囲で指定してください。');
    assert.equal(modelDraftError(modelDraft(),null),'接続名を入力してください。');
    assert.equal(modelFacts(model).find(fact=>fact.field==='contextWindow').value,'131,072 tokens');
    assert.equal(modelFacts(model).find(fact=>fact.field==='reasoning').value,'対応');
    assert.equal(i18n.t('worlds:itemCount',{count:1234}),'1,234項目');
    assert.equal(initialValueText(null),'未確定');
    assert.equal(initialValueText(true),'はい');
    assert.equal(initialValueText(false),'いいえ');

    assert.deepEqual(initialValueChildren(array),authorTexts.map((value,index)=>({
      key:'項目 '+(index+1),path:'背包['+index+']',value,
    })));
    for (const authorText of authorTexts) assert.equal(initialValueText(authorText),authorText);
    assert.equal(stateDescriptionLabel({key:'[]'}),'各項目');
    assert.equal(stateDescriptionLabel({key:'所持金'}),'所持金');
    assert.equal(modelDraft(saved).name,saved.name);
    assert.equal(modelDraft(saved).modelId,saved.modelId);

    const japaneseFailure = connectionTestError(failure);
    assert.notEqual(japaneseFailure,englishFailure);
    assert.match(japaneseFailure,/[\p{Script=Hiragana}\p{Script=Katakana}]/u);
    assert.match(japaneseFailure,/PROVIDER_ERROR/);
    assert.doesNotMatch(japaneseFailure,/server raw diagnostic fixture/);
    assert.equal(
      connectionTestError(Object.assign(new Error('raw unknown vendor diagnostic'),{errorCode:'UNKNOWN_VENDOR_ERROR'})),
      'モデルの接続テストに失敗しました（UNKNOWN_VENDOR_ERROR）',
    );

    await i18n.changeLanguage('en');
    assert.equal(frequency.label,'Frequency penalty');
    assert.equal(connectionTestError(failure),englishFailure);
    for (const authorText of authorTexts) assert.equal(initialValueText(authorText),authorText);
  } finally {
    await i18n.changeLanguage('zh-CN');
  }
});
