import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) });
async function boundaryErrors(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter(message => message.ruleId === 'architecture/boundaries');
}

describe('business module boundaries', () => {
  it.each([
    ['src/routes/sessions.ts', "import { SessionRepository } from '../sessions/repository.js';"],
    ['src/services.ts', "import { SessionRepository } from './sessions/repository.js';"],
    ['src/sessions/service.ts', "import { WorldRepository } from '../worlds/repository.js';"],
    ['src/sessions/service.ts', "import { WorldFileStore } from '../worlds/files.js';"],
    ['src/sessions/repository.ts', "import { WorldService } from '../worlds/service.js';"],
    ['src/sessions/repository.ts', "import { SessionService } from './service.js';"],
    ['src/sessions/service.ts', "import { createSessionRoutes } from '../routes/sessions.js';"],
    ['src/sessions/service.ts', "import { success } from '../http/response.js';"],
    ['src/sessions/service.ts', "import { Hono } from 'hono';"],
    ['src/sessions/service.ts', "import { transaction } from '../database/connection.js';"],
    ['src/routes/sessions.ts', "import { openDatabase } from '../database/connection.js';"],
    ['src/sessions/service.ts', "import { DatabaseSync } from 'node:sqlite';"],
    ['src/sessions/repository.ts', "class R { db = storage; stop() { this.db.close(); } }"],
    ['src/sessions/service.ts', "db.prepare('SELECT * FROM sessions');"],
    ['src/sessions/repository.ts', "db.prepare('SELECT * FROM worlds');"],
    ['src/sessions/repository.ts', "db.prepare('SELECT s.id FROM sessions s JOIN worlds w ON w.id=s.world_id');"],
    ['src/sessions/service.ts', "export { SessionRepository } from './repository.js';"],
    ['src/sessions/service.ts', "import { SessionRepository } from './repository.js'; export { SessionRepository };"],
  ])('rejects forbidden dependencies or SQL in %s', async (file, code) => {
    expect(await boundaryErrors(file, code)).not.toHaveLength(0);
  });

  it.each([
    ['src/routes/sessions.ts', "import type { SessionService } from '../sessions/service.js';"],
    ['src/sessions/service.ts', "import { SessionRepository } from './repository.js'; import type { WorldService } from '../worlds/service.js';"],
    ['src/state/service.ts', "import type { SessionService } from '../sessions/service.js';"],
    ['src/sessions/service.ts', "import type { DatabaseSync } from 'node:sqlite';"],
    ['src/sessions/service.ts', "import type { JsonObject } from '../database/connection.js';"],
    ['src/sessions/repository.ts', "import { transaction } from '../database/connection.js'; db.prepare('SELECT e.id FROM entries e JOIN sessions s ON s.id=e.session_id');"],
    ['src/worlds/repository.ts', "db.prepare('SELECT w.id FROM worlds w JOIN world_tags t ON t.world_id=w.id');"],
    ['src/app.ts', "import { createSessionRoutes } from './routes/sessions.js';"],
  ])('permits the declared boundary in %s', async (file, code) => {
    expect(await boundaryErrors(file, code)).toEqual([]);
  });
});
