import {afterEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ApiError} from '../src/api.ts';
import {SUPPORTED_LOCALES, isAppLocale, languageNames} from '@sillyrealms/sdk/locale';
import {formatDate, formatNumber} from '../src/i18n/format.ts';
import {applyLocale, createI18n, currentLocale, i18n, resources} from '../src/i18n/instance.ts';
import {errorKey, errorMessage} from '../src/i18n/errors.ts';

afterEach(async () => { await applyLocale('zh-CN'); });

function leaves(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) => typeof value === 'string'
    ? [[prefix + key, value]]
    : leaves(value, prefix + key + '.'));
}
function parameters(text) {
  return [...text.matchAll(/\{\{\s*-?\s*([^},\s]+)/g)].map(match => match[1]).sort();
}

test('every supported language explicitly provides all platform labels and matching interpolation parameters', () => {
  const chinese = new Map(leaves(resources['zh-CN']));
  assert.deepEqual(Object.keys(resources).sort(), [...SUPPORTED_LOCALES].sort());
  for (const locale of SUPPORTED_LOCALES) {
    const labels = new Map(leaves(resources[locale]));
    assert.deepEqual([...labels.keys()].sort(), [...chinese.keys()].sort(), locale + ' resource keys');
    for (const [key, value] of chinese) {
      const label = labels.get(key);
      // Japanese joins complete error sentences with a space; this is punctuation, not a label.
      assert.notEqual(key === 'stage.common.errorSeparator' ? label : label.trim(), '', 'Empty label: ' + locale + ':' + key);
      assert.deepEqual(parameters(labels.get(key)), parameters(value), 'Interpolation mismatch: ' + locale + ':' + key);
    }
  }
});

test('document instances default to Chinese and change independently without a DOM', async () => {
  const chinese = createI18n();
  const english = createI18n('en');
  const japanese = createI18n('ja');
  assert.equal(chinese.resolvedLanguage, 'zh-CN');
  assert.equal(chinese.t('settings:title'), '设置');
  assert.equal(english.t('settings:title'), 'Settings');
  assert.equal(japanese.resolvedLanguage, 'ja');
  assert.equal(japanese.t('settings:title'), '設定');
  await english.changeLanguage('zh-CN');
  assert.equal(english.t('settings:title'), '设置');
  await applyLocale('en');
  assert.equal(currentLocale(), 'en');
  assert.equal(i18n.t('settings:title'), 'Settings');
  assert.equal(chinese.t('settings:title'), '设置');
  assert.equal(japanese.t('settings:title'), '設定');
});

test('every published API error code has a message in every supported language', () => {
  // Read the public catalog without importing database, server or CLI code.
  const source = readFileSync(new URL('../../server/src/errors.ts', import.meta.url), 'utf8');
  const codes = [...source.matchAll(/^  ([A-Z][A-Z0-9_]*):\s*\{/gm)].map(match => match[1]);
  assert.ok(codes.includes('WORLD_REVISION_CONFLICT'));
  for (const code of [...codes, 'SERVER_UNAVAILABLE', 'INVALID_RESPONSE']) {
    for (const locale of SUPPORTED_LOCALES) {
      assert.equal(typeof resources[locale].errors.codes[code], 'string', 'Missing error: ' + locale + ':' + code);
    }
    assert.doesNotMatch(resources.en.errors.codes[code], /[\u4e00-\u9fff]/, 'Untranslated error: ' + code);
  }
});

test('one stored error or stable code follows the current language without leaking server diagnostics', async () => {
  const error = new ApiError('SESSION_WRITE_LOCKED', '原始服务端诊断：会话运行中', 409);
  const code = errorKey(error);
  assert.equal(code, 'SESSION_WRITE_LOCKED');
  assert.equal(errorMessage(error), '会话正在运行，暂不允许修改');
  await applyLocale('en');
  assert.equal(errorMessage(error), 'This session is running. Wait before making changes.');
  assert.equal(errorMessage(code), errorMessage(error));
  assert.equal(errorMessage('errors:localeSaveFailed'), 'Could not save the language. Try again.');
  await applyLocale('ja');
  assert.equal(errorMessage(error), resources.ja.errors.codes.SESSION_WRITE_LOCKED);
  assert.equal(errorMessage(code), errorMessage(error));
  assert.notEqual(errorMessage(code), resources.en.errors.codes.SESSION_WRITE_LOCKED);
  await applyLocale('zh-CN');
  assert.equal(errorMessage(code), '会话正在运行，暂不允许修改');
  assert.equal(error.errorMessage, '原始服务端诊断：会话运行中');
});

test('unknown API codes use a translated fallback while author diagnostics remain literal', async () => {
  await applyLocale('en');
  const unknown = new ApiError('FUTURE_SERVER_FAILURE', '不可展示的内部诊断', 500);
  assert.equal(errorMessage(unknown, 'errors:saveFailed'), 'Could not save. Try again.');
  assert.equal(errorMessage('FUTURE_SERVER_FAILURE'), 'Something went wrong. Try again.');
  assert.equal(errorMessage('errors:futureMessage'), 'Something went wrong. Try again.');
  const author = 'Author component diagnostic: 角色原始文本';
  assert.equal(errorMessage(new Error(author)), author);
  assert.equal(errorMessage(null), '');
});

test('Japanese keeps native labels, formatting, and literal author diagnostics through language switches', async () => {
  assert.equal(isAppLocale('ja'), true);
  assert.equal(isAppLocale('fr'), false);
  assert.equal(languageNames.ja, '日本語');
  await applyLocale('ja');
  assert.equal(currentLocale(), 'ja');
  assert.equal(i18n.t('sessions:sendMessage'), 'メッセージを送信');
  assert.equal(i18n.t('sessions:unknownRequests', {count: 1}), '記録されたモデルリクエストのうち1件の使用量が不明なため、合計は不完全です。');
  assert.equal(i18n.t('sessions:unknownRequests', {count: 3}), '記録されたモデルリクエストのうち3件の使用量が不明なため、合計は不完全です。');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(64000, {notation: 'compact', maximumFractionDigits: 1}), '6.4万');
  assert.equal(formatDate('2026-11-24T12:00:00Z', {year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'}), '2026年11月24日');
  assert.equal(errorMessage('sessions:invalidScope；sessions:invalidPath'), '状態のスコープが無効です。 状態フィールドのパスが無効です。');
  assert.equal(errorMessage(new ApiError('FUTURE_SERVER_FAILURE', '内部诊断', 500)), resources.ja.errors.unexpected);
  const author = '作者文本：世界原文；state.session.角色.姓名 / Author text';
  assert.equal(errorMessage(new Error(author)), author);
  await applyLocale('en');
  assert.equal(i18n.t('sessions:sendMessage'), 'Send message');
});
