import { networkInterfaces } from 'node:os';

/** Origins served by the local IPv4 Web listener, including its loopback aliases. */
export function localWebOrigins(interfaces = networkInterfaces()): string[] {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) hosts.add(address.address);
    }
  }
  return Array.from(hosts, host => `http://${host}:5176`);
}
