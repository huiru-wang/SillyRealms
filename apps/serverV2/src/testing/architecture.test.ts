import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.mjs') });

// Loading ESLint's TypeScript parser is fixture setup, independent of the boundary assertions.
beforeAll(async () => {
  await lint.lintText('', { filePath: join(root, 'src/testing/architecture-fixture.ts') });
}, 15000);

async function boundaryMessages(file: string, source: string) {
  const results = await lint.lintText(source, { filePath: join(root, 'src', file) });
  return results.flatMap(result => result.messages
    .filter(message => message.ruleId === 'architecture/boundaries')
    .map(message => message.messageId));
}

describe('Server V2 architecture boundaries', () => {
  it('keeps database ownership after moving it under infrastructure', async () => {
    expect(await boundaryMessages('infrastructure/database/example.ts', "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE example(id TEXT)');")).toEqual([]);
    expect(await boundaryMessages('modules/sessions/repository.ts', "import { transaction } from '../../infrastructure/database/transaction.js';")).toEqual([]);
    expect(await boundaryMessages('modules/sessions/service.ts', "import type { JsonObject } from '../../infrastructure/database/connection.js';")).toEqual([]);
    expect(await boundaryMessages('usecases/initialize.ts', "import type { TransactionRunner } from '../infrastructure/database/transaction.js';")).toEqual([]);
    expect(await boundaryMessages('usecases/example.ts', "import { openDatabase } from '../infrastructure/database/connection.js';")).toContain('lifecycle');
    expect(await boundaryMessages('routes/example.ts', "import type { JsonObject } from '../infrastructure/database/connection.js';")).toContain('storage');
    expect(await boundaryMessages('modules/sessions/service.ts', "import { transaction } from '../../infrastructure/database/transaction.js';")).toContain('storage');
  });

  it('does not allow the pi adapter to acquire business, transport or persistence dependencies', async () => {
    for (const target of ['../../modules/models/service.js', '../../usecases/narrative/index.js', '../../routes/models.js', '../../http/response.js', '../../services.js']) {
      expect(await boundaryMessages('infrastructure/pi/client.ts', `import type { Dependency } from '${target}';`)).toContain('infrastructure');
    }
    for (const target of ['../database/connection.js', '../events/event-hub.js']) {
      expect(await boundaryMessages('infrastructure/pi/client.ts', `import type { Dependency } from '${target}';`)).toContain('pi');
    }
    expect(await boundaryMessages('infrastructure/pi/client.ts', "import type { Context } from 'hono';")).toContain('reverse');
    expect(await boundaryMessages('infrastructure/pi/client.ts', "import type { DatabaseSync } from 'node:sqlite';")).toContain('lifecycle');
    expect(await boundaryMessages('infrastructure/pi/client.ts', "import { streamSimple } from '@earendil-works/pi-ai'; import { AppError } from '../../errors.js'; import type { ModelUsage } from './usage.js';")).toEqual([]);
    expect(await boundaryMessages('modules/models/service.ts', "import type { PiClient } from '../../infrastructure/pi/client.js';")).toContain('adapter');
  });

  it('keeps EventHub and database infrastructure independent of business usecases', async () => {
    expect(await boundaryMessages('infrastructure/events/event-hub.ts', "import type { SessionReader } from '../../modules/sessions/service.js';")).toContain('infrastructure');
    expect(await boundaryMessages('infrastructure/database/connection.ts', "import { initialize } from '../../usecases/initialize.js';")).toContain('infrastructure');
    expect(await boundaryMessages('usecases/narrative/execute.ts', "import type { SessionService } from '../../modules/sessions/service.js'; import type { EventHub } from '../../infrastructure/events/event-hub.js'; import type { ModelClient } from '../../infrastructure/model/client.js';")).toEqual([]);
  });

  it('keeps SDK types and concrete implementations behind the model contract', async () => {
    for (const file of ['usecases/example.ts', 'routes/example.ts', 'infrastructure/model/client.ts', 'usecases/example.test.ts']) {
      for (const source of [
        "import type { Model } from '@earendil-works/pi-ai';",
        "export type { Context } from '@earendil-works/pi-ai';",
        "const models = import('@earendil-works/pi-ai/providers/all');",
        "type Message = import('@earendil-works/pi-ai').AssistantMessage;",
      ]) expect(await boundaryMessages(file, source)).toContain('sdk');
    }
    expect(await boundaryMessages('usecases/narrative/execute.ts', "import type { PiClient } from '../../infrastructure/pi/client.js';")).toContain('adapter');
    expect(await boundaryMessages('infrastructure/model/client.ts', "import type { PiClient } from '../pi/client.js';")).toContain('adapter');
    expect(await boundaryMessages('usecases.ts', "import { PiClient } from './infrastructure/pi/client.js'; import type { ModelClient } from './infrastructure/model/client.js';")).toEqual([]);
    expect(await boundaryMessages('infrastructure/pi/client.ts', "import type { ModelClient } from '../model/client.js'; import type { Model } from '@earendil-works/pi-ai';")).toEqual([]);
    expect(await boundaryMessages('infrastructure/model/client.ts', "import type { EventHub } from '../events/event-hub.js';")).toContain('pi');
  });

  it('rejects original Server dependencies even through dynamic or type imports', async () => {
    for (const source of [
      "import { legacy } from '../../../server/src/runtime/config.js';",
      "export { legacy } from '../../../server/src/runtime/config.js';",
      "const legacy = import('../../../server/src/runtime/config.js');",
      "type Legacy = import('../../../server/src/runtime/config.js').Legacy;",
      "const legacy = require('../../../server/src/runtime/config.js');",
      "import type { Legacy } from '@sillyrealms/server/runtime/config';",
    ]) {
      expect(await boundaryMessages('usecases/example.ts', source)).toContain('legacy');
    }
    expect(await boundaryMessages('testing/example.test.ts', "import { legacy } from '../../../server/src/runtime/config.js';")).toContain('legacy');
  });

  it('exposes context only through its public entry, including types and external tests', async () => {
    for (const file of ['usecases/narrative/execute.ts', 'usecases/narrative/execute.test.ts']) {
      for (const source of [
        "import { projectHistory } from '../context/stages/history/index.js';",
        "export type { ContextInput } from '../context/types.js';",
        "const stage = import('../context/stages/compact/index.js');",
        "type Snapshot = import('../context/capture.js').NarrativeSnapshot;",
        "const stage = require('../context/narrative.js');",
        "import { prepareContext } from '../context';",
      ]) expect(await boundaryMessages(file, source)).toContain('contextEntry');
      expect(await boundaryMessages(file, "import { prepareContext, type PreparedContext } from '../context/index.js';")).toEqual([]);
    }
    expect(await boundaryMessages('usecases/context/index.ts', "export { prepareContext } from './narrative.js'; export type { PreparedContext } from './types.js';")).toEqual([]);
    expect(await boundaryMessages('usecases/context/index.ts', "export * from './types.js';")).toContain('wildcard');
    expect(await boundaryMessages('usecases/context/context.test.ts', "import { projectHistory } from './stages/history/index.js';")).toEqual([]);
  });

  it('keeps context stages independent of narrative execution and event transport', async () => {
    for (const target of ['../narrative/index.js', '../narrative/model-call.js', '../create-session.js', '../../infrastructure/events/event-hub.js']) {
      expect(await boundaryMessages('usecases/context/narrative.ts', `import type { Dependency } from '${target}';`)).toContain('contextDependency');
    }
    expect(await boundaryMessages('usecases/context/narrative.ts', "import { streamSSE } from 'hono/streaming';")).toContain('reverse');
    expect(await boundaryMessages('usecases/context/narrative.ts', "import type { SessionService } from '../../modules/sessions/service.js'; import type { ModelClient } from '../../infrastructure/model/client.js'; import { compactHistory } from './stages/compact/index.js';")).toEqual([]);
    for (const target of ['../../usecases/context/index.js', '../../modules/sessions/service.js']) {
      expect(await boundaryMessages('infrastructure/model/collect.ts', `import type { Dependency } from '${target}';`)).toContain('infrastructure');
    }
  });

  it('retains module privacy, read-only cross-domain contracts and SQL ownership', async () => {
    expect(await boundaryMessages('usecases/example.ts', "import type { Session } from '../modules/sessions/types.js';")).toContain('module');
    expect(await boundaryMessages('modules/state/service.ts', "import type { SessionService } from '../sessions/service.js';")).toContain('readonly');
    expect(await boundaryMessages('modules/state/service.ts', "import type { SessionReader } from '../sessions/service.js';")).toEqual([]);
    expect(await boundaryMessages('modules/worlds/repository.ts', "db.prepare('SELECT * FROM entries');")).toContain('table');
    expect(await boundaryMessages('usecases/example.ts', "db.prepare('SELECT * FROM entries');")).toContain('sqlLayer');
  });
});
