import { readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';
import { isIP } from 'node:net';

const managed = '# Managed by SillyRealms deploy/start.sh.';
const environmentKeys = Object.freeze({
  webOrigin: 'WEB_ORIGIN',
  stageOrigin: 'STAGE_ORIGIN',
  serverPort: 'SERVER_PORT',
  dataRoot: 'SERVER_DATA_ROOT',
  staticRoot: 'STATIC_ROOT',
  nginxDir: 'NGINX_DIR',
  webTlsCert: 'WEB_TLS_CERT',
  webTlsKey: 'WEB_TLS_KEY',
  stageTlsCert: 'STAGE_TLS_CERT',
  stageTlsKey: 'STAGE_TLS_KEY',
  tlsCaFile: 'TLS_CA_FILE',
});
export const CONFIG_KEYS = Object.freeze(Object.keys(environmentKeys));

function absolutePath(value, name) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_.@+/-]+$/.test(value) ||
      value.endsWith('/') || value.includes('//') ||
      value.split('/').some(segment => segment === '.' || segment === '..') ||
      path.normalize(value) !== value) {
    throw new Error(name + ' must be a normalized absolute path without spaces, traversal or shell/config interpolation characters');
  }
  return value;
}

function origin(value, name) {
  // Parse only an origin; URL otherwise silently accepts paths, backslashes and whitespace.
  if (typeof value !== 'string' ||
      !/^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?$/.test(value)) {
    throw new Error(name + ' must be an HTTP(S) origin without a path, trailing slash, query, fragment or credentials');
  }
  let url;
  try { url = new URL(value); }
  catch { throw new Error(name + ' is not a valid HTTP(S) origin'); }
  if (url.hostname === '' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(name + ' is not a valid HTTP(S) origin');
  }
  const address = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(address) && (address.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(address))) {
    throw new Error(name + ' must contain a valid IP address or hostname');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port < 1 || port > 65535) throw new Error(name + ' has an invalid port');
  return { origin: url.origin, hostname: url.hostname, port, protocol: url.protocol };
}

function overlap(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function optionalPath(value, name) {
  return value === undefined || value === null || value === '' ? undefined : absolutePath(value, name);
}

/** Validate before constructing shell-free systemd and Nginx configuration. */
export function normalizeConfig(raw, { projectDir, configDir = '/etc/sillyrealms' } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('deploy.json must contain a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) throw new Error('Unknown deployment option: ' + key);
  }
  projectDir = absolutePath(projectDir, 'projectDir');
  configDir = absolutePath(configDir, 'configDir');
  const web = origin(raw.webOrigin, 'webOrigin / WEB_ORIGIN');
  const stage = origin(raw.stageOrigin, 'stageOrigin / STAGE_ORIGIN');
  if (web.origin === stage.origin) throw new Error('Web and Stage must use different origins');
  if (web.protocol === 'https:' && stage.protocol !== 'https:') {
    throw new Error('HTTPS Web requires HTTPS Stage');
  }
  if (web.port === stage.port && web.protocol !== stage.protocol) {
    throw new Error('One Nginx listen port cannot mix HTTP and HTTPS');
  }
  const rawPort = raw.serverPort ?? 3001;
  if (!((typeof rawPort === 'number' && Number.isInteger(rawPort)) ||
      (typeof rawPort === 'string' && /^[1-9][0-9]*$/.test(rawPort)))) {
    throw new Error('serverPort / SERVER_PORT must be an integer from 1 to 65535');
  }
  const serverPort = Number(rawPort);
  if (!Number.isSafeInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error('serverPort / SERVER_PORT must be an integer from 1 to 65535');
  }
  if (serverPort === web.port || serverPort === stage.port) {
    throw new Error('SERVER_PORT must not collide with either Nginx listen port');
  }
  const dataRoot = absolutePath(raw.dataRoot ?? projectDir + '/data', 'dataRoot');
  const staticRoot = absolutePath(raw.staticRoot ?? '/var/www/sillyrealms', 'staticRoot');
  const nginxDir = absolutePath(raw.nginxDir ?? '/etc/nginx', 'nginxDir');
  if (path.dirname(staticRoot) === '/') {
    throw new Error('staticRoot must be a dedicated subdirectory, never a top-level system directory');
  }
  for (const [name, value] of Object.entries({ projectDir, dataRoot, configDir, nginxDir })) {
    if (overlap(staticRoot, value)) {
      throw new Error('staticRoot must not overlap ' + name + ' or expose application/configuration data');
    }
  }
  const tls = {
    webTlsCert: optionalPath(raw.webTlsCert, 'webTlsCert'),
    webTlsKey: optionalPath(raw.webTlsKey, 'webTlsKey'),
    stageTlsCert: optionalPath(raw.stageTlsCert, 'stageTlsCert'),
    stageTlsKey: optionalPath(raw.stageTlsKey, 'stageTlsKey'),
    tlsCaFile: optionalPath(raw.tlsCaFile, 'tlsCaFile'),
  };
  for (const [name, endpoint] of Object.entries({ web, stage })) {
    const cert = tls[name + 'TlsCert'], key = tls[name + 'TlsKey'];
    if (endpoint.protocol === 'https:' && (!cert || !key)) {
      throw new Error(name + ' HTTPS requires both TLS certificate and private key paths');
    }
    if (endpoint.protocol === 'http:' && (cert || key)) {
      throw new Error(name + ' TLS paths require an HTTPS origin; clear both paths when using HTTP');
    }
  }
  return {
    projectDir, configDir,
    webOrigin: web.origin, stageOrigin: stage.origin, serverPort,
    dataRoot, staticRoot, nginxDir, ...tls,
    keyFile: configDir + '/credential.key',
    credentialsDir: dataRoot + '/credentials',
    web, stage,
  };
}

/** Saved JSON is authoritative until a named environment variable explicitly overrides it. */
export async function loadConfig({ projectDir, configDir = '/etc/sillyrealms', env = process.env } = {}) {
  configDir = absolutePath(configDir, 'configDir');
  let saved = {};
  try {
    const content = await readFile(configDir + '/deploy.json', 'utf8');
    try { saved = JSON.parse(content); }
    catch { throw new Error(configDir + '/deploy.json contains invalid JSON'); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('deploy.json must contain a JSON object');
  }
  const raw = { ...saved };
  for (const [key, variable] of Object.entries(environmentKeys)) {
    if (Object.hasOwn(env, variable) && env[variable] !== undefined) raw[key] = env[variable];
  }
  return normalizeConfig(raw, { projectDir, configDir });
}

function tlsSnippet(endpoint, cert, key) {
  if (endpoint.protocol !== 'https:') return '';
  return [
    '    ssl_certificate ' + cert + ';',
    '    ssl_certificate_key ' + key + ';',
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    ssl_session_timeout 1d;',
    '    ssl_session_tickets off;',
  ].join('\n') + '\n';
}

export async function renderNginx(config) {
  const template = await readFile(new URL('./nginx.conf.template', import.meta.url), 'utf8');
  const values = {
    WEB_LISTEN: (config.web.hostname.startsWith('[') ? '[::]:' : '') + config.web.port + (config.web.protocol === 'https:' ? ' ssl' : ''),
    STAGE_LISTEN: (config.stage.hostname.startsWith('[') ? '[::]:' : '') + config.stage.port + (config.stage.protocol === 'https:' ? ' ssl' : ''),
    WEB_HOST: config.web.hostname,
    STAGE_HOST: config.stage.hostname,
    WEB_TLS: tlsSnippet(config.web, config.webTlsCert, config.webTlsKey),
    STAGE_TLS: tlsSnippet(config.stage, config.stageTlsCert, config.stageTlsKey),
    WEB_ROOT: config.staticRoot + '/current/web',
    STAGE_ROOT: config.staticRoot + '/current/stage',
    WEB_ORIGIN: config.webOrigin,
    SERVER_PORT: String(config.serverPort),
  };
  return template.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error('Unknown Nginx template variable: ' + key);
    return values[key];
  });
}

export function renderEnvironment(config) {
  return [
    managed,
    'NODE_ENV=production',
    'SERVER_PORT=' + config.serverPort,
    'SERVER_DATA_ROOT=' + config.dataRoot,
    'SERVER_WEB_ORIGIN=' + config.webOrigin,
    'SERVER_STAGE_ORIGIN=' + config.stageOrigin,
    'SERVER_CREDENTIAL_KEY_FILE=' + config.keyFile,
    'SERVER_DEBUG=false',
    '',
  ].join('\n');
}

export function renderSystemd(config, { nodePath, loaderPath }) {
  nodePath = absolutePath(nodePath, 'nodePath');
  loaderPath = absolutePath(loaderPath, 'loaderPath');
  return [
    managed,
    '[Unit]',
    'Description=SillyRealms API server',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'User=root',
    'WorkingDirectory=' + config.projectDir,
    'EnvironmentFile=' + config.configDir + '/server.env',
    'ExecStart=' + nodePath + ' --import ' + loaderPath + ' ' + config.projectDir + '/deploy/server.mjs',
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=45',
    'KillSignal=SIGTERM',
    'KillMode=control-group',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}
