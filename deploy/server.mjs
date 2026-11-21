import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEncryptedCredentialStore } from './credentials.mjs';

export async function deploymentOptions(env = process.env) {
  const dataRoot = resolve(env.SERVER_DATA_ROOT ?? fileURLToPath(new URL('../data/', import.meta.url)));
  if (!env.SERVER_CREDENTIAL_KEY_FILE) throw new Error('SERVER_CREDENTIAL_KEY_FILE is required');
  return {
    port: Number(env.SERVER_PORT ?? '3001'),
    dataRoot,
    webOrigin: env.SERVER_WEB_ORIGIN,
    stageOrigin: env.SERVER_STAGE_ORIGIN,
    debug: env.SERVER_DEBUG === 'true',
    credentialStore: await createEncryptedCredentialStore({
      directory: join(dataRoot, 'credentials'),
      keyFile: env.SERVER_CREDENTIAL_KEY_FILE,
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Use the existing application lifecycle; only deployment's credential adapter differs.
    const { startServer } = await import('../apps/server/src/server.ts');
    const running = await startServer(await deploymentOptions());
    const address = running.server.address();
    if (address && typeof address !== 'string') console.log('Server: http://127.0.0.1:' + address.port);
    const stop = () => {
      void running.close().catch(error => {
        console.error('SERVER_SHUTDOWN_FAILED', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error('SERVER_START_FAILED', error);
    process.exitCode = 1;
  }
}
