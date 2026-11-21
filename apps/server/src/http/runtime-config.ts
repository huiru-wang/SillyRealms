export type RuntimeConfig = {
  stage: { origin: string; entryPath: '/frame.html' };
  debug: boolean;
};

/** Public deployment settings only; no model credentials or internal listen addresses. */
export function runtimeConfig({ webOrigin, stageOrigin, debug = false }: {
  webOrigin: string; stageOrigin?: string; debug?: boolean;
}): RuntimeConfig {
  const host = new URL(webOrigin);
  const stage = new URL(stageOrigin ?? host.origin);
  if (stageOrigin === undefined) stage.port = '5177';
  if (!['http:', 'https:'].includes(stage.protocol) || (stageOrigin !== undefined && stage.origin !== stageOrigin) ||
    stage.username || stage.password || stage.origin === host.origin ||
    (host.protocol === 'https:' && stage.protocol !== 'https:') || typeof debug !== 'boolean') {
    throw new Error('Invalid isolated stage configuration');
  }
  return { stage: { origin: stage.origin, entryPath: '/frame.html' }, debug };
}
