/** Untrusted component documents may load public files, never call management APIs. */
export function allowApiOrigin(origin: string | undefined, requestUrl: string, method: string, webOrigin: string): boolean {
  const url = new URL(requestUrl);
  if ((method === 'GET' || method === 'HEAD') && /^\/api\/v1\/worlds\/[^/]+\/resources\/.+/.test(url.pathname)) return true;
  return origin === undefined || origin === url.origin || origin === webOrigin;
}

export function parseWebOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Invalid SERVER_WEB_ORIGIN');
  return url.origin;
}
