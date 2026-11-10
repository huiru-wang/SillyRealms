import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { ErrorCodes, ErrorMessages, errorInfo, normalizeError } from '../src/common/error-codes.js';
import { RuntimeError } from '../src/agent/shared/errors.js';

it('binds every public code to one fixed description and sanitizes details', () => {
  for (const code of Object.values(ErrorCodes)) {
    expect(ErrorMessages[code]).toBeTruthy();
    expect(errorInfo(code)).toEqual({ errorCode: code, errorMessage: ErrorMessages[code] });
  }
  expect(errorInfo(ErrorCodes.INVALID_WORLD, 'path:\ninvalid')).toEqual({
    errorCode: 'INVALID_WORLD', errorMessage: '世界卡内容无效：path: invalid',
  });
  expect(normalizeError(new RuntimeError(ErrorCodes.INVALID_STATE_PATH))).toEqual({
    errorCode: 'INVALID_STATE_PATH', errorMessage: '状态路径无效',
  });
  expect(normalizeError(new Error('Provider secret:123'))).toEqual({
    errorCode: 'INTERNAL_ERROR', errorMessage: '服务器内部错误',
  });
});

it('returns exactly four standard keys for ordinary API and health responses', async () => {
  const db = openDatabase(':memory:');
  try {
    const app = createApp(db);
    for (const [path, expected] of [
      ['/health', { success:true, errorCode:null, errorMessage:'', data:{ok:true} }],
      ['/api/does-not-exist', { success:false, errorCode:'NOT_FOUND', errorMessage:'接口不存在', data:null }],
      ['/api/v1/worlds/nope/export', { success:false, errorCode:'WORLD_NOT_FOUND', errorMessage:'世界卡不存在', data:null }],
    ] as const) {
      const response = await app.request(path);
      const body = await response.json() as Record<string,unknown>;
      expect(body).toEqual(expected);
      expect(Object.keys(body).sort()).toEqual(['data','errorCode','errorMessage','success']);
    }
  } finally { db.close(); }
});
