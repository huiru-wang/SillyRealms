/** Management and isolated documents must never be served by the same Vite surface. */
export function allowsEntry(pathname: string, isolated: boolean): boolean {
  const entries = isolated ? ['/frame.html', '/world-component.html'] : ['/index.html'];
  if (isolated && (pathname === '/' || pathname === '/api' || pathname.startsWith('/api/'))) return false;
  return !pathname.endsWith('.html') || entries.includes(pathname);
}
