export type RuntimeConfig = {
  stage: { origin: string; entryPath: '/frame.html' };
  debug: boolean;
};

/** Public deployment settings only; no model credentials or internal listen addresses. */
export function runtimeConfig({ studioOrigin, stageOrigin = 'http://127.0.0.1:5177', debug = false }: {
  studioOrigin: string; stageOrigin?: string; debug?: boolean;
}): RuntimeConfig {
  const host = new URL(studioOrigin), stage = new URL(stageOrigin);
  if (!['http:', 'https:'].includes(stage.protocol) || stage.origin !== stageOrigin ||
    stage.username || stage.password || stage.origin === host.origin ||
    (host.protocol === 'https:' && stage.protocol !== 'https:') || typeof debug !== 'boolean') {
    throw new Error('Invalid isolated stage configuration');
  }
  return { stage: { origin: stage.origin, entryPath: '/frame.html' }, debug };
}
