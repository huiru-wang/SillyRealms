/** The local host and isolated renderer share a hostname and use distinct ports. */
export function localOrigin(origin: string, port: 5176 | 5177): string {
  const url = new URL(origin);
  url.port = String(port);
  return url.origin;
}
