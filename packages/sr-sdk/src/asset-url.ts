/** Portable package paths are decoded text, never URL-encoded filesystem paths. */
export type PackageRoot = 'assets' | 'components';
const forbiddenPath = /[\\\u0000-\u001f\u007f%?#:*"<>|]/u;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

export function validatePackagePath(path: string, root?: PackageRoot): string {
  if (typeof path !== 'string' || !path || path.startsWith('/') ||
      forbiddenPath.test(path) || byteLength(path) > 4096) {
    throw new Error('包内路径无效');
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
      /[. ]$/.test(segment) || reservedName.test(segment) || byteLength(segment) > 255)) {
    throw new Error('包内路径包含无效的文件名');
  }
  if (root && (segments[0] !== root || segments.length < 2)) {
    throw new Error('包内路径必须位于 ' + root + '/ 目录下');
  }
  return path;
}

export function parseSRAssetUri(uri: string, root?: PackageRoot): string {
  if (typeof uri !== 'string' || !uri.startsWith('sr-asset://')) {
    throw new Error('包内资源必须使用 sr-asset://');
  }
  // Do not use URL.pathname here: the standard URL parser treats assets as a host.
  const path = validatePackagePath(uri.slice('sr-asset://'.length), root);
  if (!root && !path.startsWith('assets/') && !path.startsWith('components/')) {
    throw new Error('包内资源必须位于 assets/ 或 components/ 目录下');
  }
  return path;
}

/** Validate the trusted Host-provided resource base; never resolve against location.origin. */
export function parseSRAssetBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('世界资源地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !/^\/world-assets\/[^/]+\/$/.test(url.pathname)) {
    throw new Error('世界资源地址无效');
  }
  return url;
}

/** Pure URL conversion. Existence, byte loading, caching and Range stay browser/server-owned. */
export function resolveSRAssetUrl(
  uri: string | null | undefined,
  assetBaseUrl: string | null | undefined,
): string | null {
  if (uri == null) return null;
  if (typeof uri !== 'string' || !uri || /[\u0000-\u001f\u007f]/u.test(uri)) {
    throw new Error('资源地址无效');
  }
  if (/^sr-asset:/i.test(uri)) {
    const path = parseSRAssetUri(uri, 'assets');
    if (!assetBaseUrl) throw new Error('包内资源不可用：缺少当前世界的资源地址');
    const base = parseSRAssetBaseUrl(assetBaseUrl);
    return new URL(path.split('/').map(encodeURIComponent).join('/'), base).href;
  }
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error('资源地址必须使用 HTTP(S) 或 sr-asset://'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('资源地址必须使用 HTTP(S) 或 sr-asset://');
  }
  return url.href;
}
