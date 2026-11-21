import {defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer} from 'vite';
import react from '@vitejs/plugin-react';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {localWebOrigins} from '../../scripts/local-network.mts';
import {allowsEntry} from './entry-policy';

function surface(preview: boolean, hosts: string[], csp: string): Plugin {
  const applyPolicy = (html: string) =>
    html.replace(/content="default-src[^"]*"/, () => 'content="' + csp + '"');

  function configure(server: ViteDevServer | PreviewServer) {
    server.printUrls = () => {
      const info = server.config.logger.info;
      if (preview) {
        info('  隔离舞台已就绪（5177），由 Web 主站加载。');
      } else {
        const urls = hosts.length > 1 ? hosts.filter(url => url !== 'http://localhost:5176') : hosts;
        info(urls.map(url => '  Web 主站  ' + url + '/').join('\n'));
      }
    };
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!allowsEntry(path, preview)) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      next();
    });
  }

  return {
    name: 'web-entry-boundary',
    transformIndexHtml: html => preview ? applyPolicy(html) : html,
    configureServer: configure,
    configurePreviewServer(server) {
      configure(server);
      if (!preview) return;
      // The build may have been produced on another network. Pin its HTML policy to this host.
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!['/frame.html', '/world-component.html'].includes(path) ||
          (req.method !== 'GET' && req.method !== 'HEAD')) return next();
        const file = resolve(server.config.root, server.config.build.outDir, path.slice(1));
        void readFile(file, 'utf8').then(html => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Content-Security-Policy', csp + '; frame-ancestors ' + hosts.join(' '));
          res.end(req.method === 'HEAD' ? undefined : applyPolicy(html));
        }).catch(next);
      });
    },
  };
}

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, process.cwd(), ''), preview = mode === 'world-preview';
  const web = env.VITE_WEB_ORIGIN;
  if (web !== undefined) {
    const url = new URL(web);
    if (url.origin !== web || !['http:', 'https:'].includes(url.protocol)) throw Error('Invalid VITE_WEB_ORIGIN');
  }
  // Static deployments use their configured origin. Local servers trust only this machine's Web origins.
  const hosts = web ? [web] : command === 'build' ? ['http://127.0.0.1:5176'] : localWebOrigins();
  const sources = hosts.join(' ');
  const csp = "default-src 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https: data: blob: " + sources + "; media-src 'self' https: blob: " + sources +
    "; font-src 'self' data: " + sources + "; connect-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  const api = env.SR_WEB_SERVER_URL ?? 'http://127.0.0.1:' + (env.SERVER_PORT ?? '3001');
  const listener = {
    host: '0.0.0.0', port: preview ? 5177 : 5176, strictPort: true,
    headers: preview ? {'Content-Security-Policy': csp + '; frame-ancestors ' + sources} : undefined,
    proxy: preview ? undefined : {'/api': {target: api, changeOrigin: false}},
  };
  return {
    clearScreen: false,
    cacheDir: preview ? 'node_modules/.vite-stage' : 'node_modules/.vite',
    plugins: [react(), surface(preview, hosts, csp)],
    appType: preview ? 'mpa' : 'spa',
    resolve: {dedupe: ['react', 'react-dom']},
    server: {
      ...listener,
      fs: {allow: [process.cwd(), resolve('../../packages'), resolve('../../node_modules')]},
    },
    preview: listener,
    build: {
      outDir: preview ? 'dist-preview' : 'dist',
      rollupOptions: {input: preview
        ? {stage: resolve(process.cwd(), 'frame.html'), world: resolve(process.cwd(), 'world-component.html')}
        : resolve(process.cwd(), 'index.html')},
    },
  };
});
