import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_KEYS, loadConfig, normalizeConfig, renderEnvironment, renderNginx, renderSystemd } from './config.mjs';

const location = { projectDir: '/root/SillyRealms', configDir: '/etc/sillyrealms' };
const base = { webOrigin: 'http://203.0.113.10', stageOrigin: 'http://203.0.113.10:8081' };
const normalize = raw => normalizeConfig({ ...base, ...raw }, location);
const tls = {
  webOrigin: 'https://sr.example.com', stageOrigin: 'https://stage.example.com',
  webTlsCert: '/etc/letsencrypt/live/sr.example.com/fullchain.pem',
  webTlsKey: '/etc/letsencrypt/live/sr.example.com/privkey.pem',
  stageTlsCert: '/etc/letsencrypt/live/stage.example.com/fullchain.pem',
  stageTlsKey: '/etc/letsencrypt/live/stage.example.com/privkey.pem',
};

test('defaults preserve source/data under root while static content is separate', () => {
  const result = normalize();
  assert.equal(result.projectDir, '/root/SillyRealms');
  assert.equal(result.dataRoot, '/root/SillyRealms/data');
  assert.equal(result.staticRoot, '/var/www/sillyrealms');
  assert.equal(result.nginxDir, '/etc/nginx');
  assert.equal(result.keyFile, '/etc/sillyrealms/credential.key');
  assert.equal(result.credentialsDir, '/root/SillyRealms/data/credentials');
  assert.equal(result.serverPort, 3001);
  assert.deepEqual(result.web, { origin: base.webOrigin, hostname: '203.0.113.10', port: 80, protocol: 'http:' });
  assert.equal(result.stage.port, 8081);
});

test('canonicalizes default ports and host casing before checking origin isolation', () => {
  const result = normalize({ webOrigin: 'http://SR.Example.com:80', stageOrigin: 'http://stage.example.com:80' });
  assert.equal(result.webOrigin, 'http://sr.example.com');
  assert.equal(result.stage.port, 80);
  assert.throws(() => normalize({ webOrigin: 'http://SR.Example.com:80', stageOrigin: 'http://sr.example.com' }), /different origins/);
});

test('origins must be explicit, valid and free of injected or normalized-away content', () => {
  const bad = [
    undefined, null, '', 'http://example.com/', 'http://example.com/path',
    'http://example.com?x=1', 'http://example.com#fragment', 'http://u:p@example.com',
    'file:///etc/passwd', 'ftp://example.com', ' http://example.com',
    'http://example.com\n', 'http://example.com\\path', 'http://$host',
    'http://example.com;return 200;', 'http://example.com:0', 'http://example.com:65536',
    'http://example.com:bad', 'http://-example.com', 'http://example..com',
    'http://.', 'http://[invalid]',
  ];
  for (const value of bad) assert.throws(() => normalize({ webOrigin: value }), /origin|port|hostname|HTTP/);
  assert.throws(() => normalizeConfig({}, location), /webOrigin/);
  assert.throws(() => normalize({ stageOrigin: undefined }), /stageOrigin/);
});

test('HTTPS needs two certificate/key pairs and never embeds an insecure Stage', () => {
  assert.equal(normalize(tls).stage.port, 443);
  assert.throws(() => normalize({ ...tls, stageOrigin: 'http://stage.example.com' }), /HTTPS Stage/);
  for (const field of ['webTlsCert', 'webTlsKey', 'stageTlsCert', 'stageTlsKey']) {
    assert.throws(() => normalize({ ...tls, [field]: undefined }), /requires both TLS/);
  }
  assert.throws(() => normalize({ webTlsCert: tls.webTlsCert, webTlsKey: tls.webTlsKey }), /HTTPS origin/);
  assert.throws(() => normalize({
    ...tls, webOrigin: 'http://sr.example.com:8080', stageOrigin: 'https://stage.example.com:8080',
  }), /cannot mix HTTP and HTTPS/);
});

test('rejects invalid API ports and collisions with either public listener', () => {
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '', 'abc', '3001x', ' 3001', '03001', true]) {
    assert.throws(() => normalize({ serverPort: port }), /SERVER_PORT/);
  }
  for (const serverPort of [80, 8081]) assert.throws(() => normalize({ serverPort }), /collide/);
  assert.equal(normalize({ serverPort: '3002' }).serverPort, 3002);
  assert.equal(normalize({ serverPort: 65535 }).serverPort, 65535);
});

test('rejects path interpolation/traversal instead of escaping config-language input', () => {
  const paths = [
    '/', 'relative/path', '/tmp/a b', '/tmp/a\nb', '/tmp/$HOME', '/tmp/%n',
    '/tmp/a"b', "/tmp/a'b", '/tmp/a;b', '/tmp/../data', '/tmp/./data',
    '/tmp//data', '/tmp/data/', '/tmp/a\\b', '/tmp/a\0b', 123,
  ];
  for (const field of ['dataRoot', 'staticRoot', 'nginxDir']) {
    for (const value of paths) assert.throws(() => normalize({ [field]: value }), /path|directory/);
  }
  for (const value of paths) {
    assert.throws(() => normalizeConfig(base, { ...location, projectDir: value }), /path/);
    assert.throws(() => normalizeConfig(base, { ...location, configDir: value }), /path/);
    assert.throws(() => normalize({ ...tls, webTlsKey: value }), /path/);
  }
  assert.equal(normalize({ dataRoot: '/srv/sr-data_v2.1+backup' }).dataRoot, '/srv/sr-data_v2.1+backup');
});

test('static publishing cannot overlap source, private data or system configuration', () => {
  for (const staticRoot of [
    '/root', '/etc', '/var', '/root/SillyRealms', '/root/SillyRealms/public',
    '/root/SillyRealms/data', '/root/SillyRealms/data/public',
    '/etc/sillyrealms', '/etc/sillyrealms/public', '/etc/nginx', '/etc/nginx/html',
  ]) {
    assert.throws(() => normalize({ staticRoot }), /staticRoot/);
  }
  assert.throws(() => normalize({ staticRoot: '/srv/app', dataRoot: '/srv/app/private' }), /overlap dataRoot/);
  assert.equal(normalize({ staticRoot: '/srv/SillyRealms-public' }).staticRoot, '/srv/SillyRealms-public');
});

test('configuration rejects typo keys and non-object documents', () => {
  for (const value of [null, [], 'json', 123]) assert.throws(() => normalizeConfig(value, location), /JSON object/);
  assert.throws(() => normalize({ web_origin: base.webOrigin }), /Unknown deployment option/);
  assert.equal(CONFIG_KEYS.length, 11);
  assert.ok(CONFIG_KEYS.includes('tlsCaFile'));
});

test('loadConfig supports first-run environment, persisted JSON, and explicit overrides', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'sr-deploy-config-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const args = { projectDir: location.projectDir, configDir };
  const initial = await loadConfig({ ...args, env: { WEB_ORIGIN: base.webOrigin, STAGE_ORIGIN: base.stageOrigin } });
  assert.equal(initial.serverPort, 3001);
  assert.equal(initial.keyFile, configDir + '/credential.key');
  await writeFile(join(configDir, 'deploy.json'), JSON.stringify({ ...base, serverPort: 3002, dataRoot: '/srv/sr-private' }));
  const saved = await loadConfig({ ...args, env: {} });
  assert.equal(saved.serverPort, 3002);
  assert.equal(saved.dataRoot, '/srv/sr-private');
  const changed = await loadConfig({ ...args, env: { SERVER_PORT: '3003', SERVER_DATA_ROOT: '/srv/sr-next', UNRELATED: 'ignored' } });
  assert.equal(changed.serverPort, 3003);
  assert.equal(changed.dataRoot, '/srv/sr-next');
  assert.equal(changed.webOrigin, base.webOrigin);
  await assert.rejects(loadConfig({ ...args, env: { WEB_ORIGIN: '' } }), /webOrigin/);
});

test('invalid persisted JSON never falls back to an empty config', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'sr-deploy-json-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const args = { projectDir: location.projectDir, configDir, env: { WEB_ORIGIN: base.webOrigin, STAGE_ORIGIN: base.stageOrigin } };
  for (const content of ['{invalid', 'null', '[]']) {
    await writeFile(join(configDir, 'deploy.json'), content);
    await assert.rejects(loadConfig(args), /invalid JSON|JSON object/);
  }
});

test('Nginx keeps Web, API streaming and isolated Stage routes separate', async () => {
  const text = await renderNginx(normalize());
  const [main, stage] = text.split('# Isolated Stage:');
  assert.ok(text.startsWith('# Managed by SillyRealms.\n'));
  assert.doesNotMatch(text, /@@[A-Z_]+@@/);
  assert.match(main, /root \/var\/www\/sillyrealms\/current\/web;/);
  assert.match(stage, /root \/var\/www\/sillyrealms\/current\/stage;/);
  assert.match(main, /proxy_set_header Host \$http_host;/);
  assert.match(main, /client_max_body_size 300m;/);
  assert.match(main, /location = \/health \{\s*proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.match(main, /location \^~ \/api\/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.doesNotMatch(main, /proxy_pass http:\/\/127\.0\.0\.1:3001\//);
  for (const directive of ['proxy_buffering off;', 'proxy_cache off;', 'gzip off;', 'proxy_read_timeout 3600s;']) {
    assert.ok(main.includes(directive), directive);
  }
  assert.match(main, /location ~\* \\\.html\$ \{\s*return 404;/);
  assert.match(main, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.doesNotMatch(stage, /proxy_pass|\/index\.html|try_files .*\/index/);
  assert.match(stage, /location = \/api \{\s*return 404;/);
  assert.match(stage, /location \^~ \/api\/ \{\s*return 404;/);
  assert.match(stage, /location = \/ \{\s*return 404;/);
  for (const entry of ['frame.html', 'world-component.html']) {
    assert.ok(stage.includes('location = /' + entry + ' {'));
  }
  assert.equal((stage.match(/frame-ancestors http:\/\/203\.0\.113\.10/g) ?? []).length, 2);
  assert.doesNotMatch(text, /X-Frame-Options|ssl_certificate|listen \d+ ssl/);
  assert.equal((text.match(/max-age=31536000, immutable/g) ?? []).length, 2);
  assert.equal((text.match(/Cache-Control "no-cache" always/g) ?? []).length, 3);
});

test('TLS rendering and explicit IPv6 listen sockets match configured origins', async () => {
  const text = await renderNginx(normalize(tls));
  assert.equal((text.match(/listen 443 ssl;/g) ?? []).length, 2);
  assert.ok(text.includes('ssl_certificate ' + tls.webTlsCert + ';'));
  assert.ok(text.includes('ssl_certificate_key ' + tls.stageTlsKey + ';'));
  assert.match(text, /frame-ancestors https:\/\/sr\.example\.com/);
  const v6 = await renderNginx(normalize({ webOrigin: 'http://[::1]', stageOrigin: 'http://[::1]:8081' }));
  assert.match(v6, /listen \[::\]:80;/);
  assert.match(v6, /listen \[::\]:8081;/);
});

test('systemd directly owns one Node process, preserves root access, and gets stable env paths', () => {
  const config = normalize();
  const options = {
    nodePath: '/root/.nvm/versions/node/v22.23.2/bin/node',
    loaderPath: '/root/SillyRealms/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs',
  };
  const unit = renderSystemd(config, options);
  assert.ok(unit.startsWith('# Managed by SillyRealms.\n'));
  assert.ok(unit.includes('ExecStart=' + options.nodePath + ' --import ' + options.loaderPath + ' /root/SillyRealms/deploy/server.mjs\n'));
  assert.match(unit, /User=root\nWorkingDirectory=\/root\/SillyRealms\n/);
  assert.match(unit, /EnvironmentFile=\/etc\/sillyrealms\/server\.env\n/);
  assert.match(unit, /Restart=on-failure\n/);
  assert.match(unit, /TimeoutStopSec=45\n/);
  assert.match(unit, /UMask=0077\n/);
  assert.doesNotMatch(unit, /ProtectHome=true|pnpm start|bash|nohup|cluster/);
  for (const key of ['nodePath', 'loaderPath']) {
    for (const value of ['/tmp/node --inspect', '/tmp/%n', '/tmp/$node', '/tmp/../node']) {
      assert.throws(() => renderSystemd(config, { ...options, [key]: value }), /path/);
    }
  }
  const env = renderEnvironment(config);
  assert.match(env, /^# Managed by SillyRealms\./);
  for (const line of [
    'NODE_ENV=production', 'SERVER_PORT=3001', 'SERVER_DATA_ROOT=/root/SillyRealms/data',
    'SERVER_WEB_ORIGIN=' + base.webOrigin, 'SERVER_STAGE_ORIGIN=' + base.stageOrigin,
    'SERVER_CREDENTIAL_KEY_FILE=/etc/sillyrealms/credential.key', 'SERVER_DEBUG=false',
  ]) assert.ok(env.split('\n').includes(line), line);
  assert.doesNotMatch(env, /SERVER_CREDENTIALS_DIR|API_KEY=/);
});

test('optional TLS CA file is a safe absolute path and can be omitted', () => {
  assert.equal(normalize(tls).tlsCaFile, undefined);
  assert.equal(normalize({ ...tls, tlsCaFile: '/etc/nginx/ssl/cloudflare-origin-ca.pem' }).tlsCaFile,
    '/etc/nginx/ssl/cloudflare-origin-ca.pem');
  for (const value of ['relative.pem', '/tmp/a b.pem', '/tmp/../ca.pem', '/tmp/$CA.pem']) {
    assert.throws(() => normalize({ ...tls, tlsCaFile: value }), /tlsCaFile.*path/);
  }
  assert.equal(normalize({ ...tls, tlsCaFile: '' }).tlsCaFile, undefined);
});

test('TLS CA selection persists in deployment JSON and allows explicit override or clearing', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'sr-deploy-ca-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const args = { projectDir: location.projectDir, configDir };
  const first = await loadConfig({ ...args, env: {
    WEB_ORIGIN: base.webOrigin, STAGE_ORIGIN: base.stageOrigin, TLS_CA_FILE: '/etc/nginx/ssl/origin-ca.pem',
  } });
  assert.equal(first.tlsCaFile, '/etc/nginx/ssl/origin-ca.pem');
  const saved = Object.fromEntries(CONFIG_KEYS.map(key => [key, first[key]]));
  await writeFile(join(configDir, 'deploy.json'), JSON.stringify(saved));
  assert.equal((await loadConfig({ ...args, env: {} })).tlsCaFile, first.tlsCaFile);
  assert.equal((await loadConfig({ ...args, env: { TLS_CA_FILE: '/etc/ssl/certs/other-ca.pem' } })).tlsCaFile,
    '/etc/ssl/certs/other-ca.pem');
  assert.equal((await loadConfig({ ...args, env: { TLS_CA_FILE: '' } })).tlsCaFile, undefined);
});
