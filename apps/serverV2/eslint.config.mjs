import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
const tables = {
  presets: ['presets'],
  models: ['api_model_configs'],
  settings: ['app_settings'],
  worlds: ['worlds', 'world_tags'],
  sessions: ['sessions', 'entries'],
  state: [],
};
const businessTables = new Set(Object.values(tables).flat());
const sourcePath = file => relative(sourceRoot, file).split(sep).join('/');

const boundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      repository: 'Repository is private: only the owning Service may import it.',
      module: 'The only public business module entry is service.ts.',
      reverse: 'Dependencies must flow route -> service -> repository; upward dependencies are forbidden.',
      storage: 'Services cannot retain database behavior or start transactions; routes cannot access storage.',
      lifecycle: 'Only startup/database infrastructure may open or close the database.',
      sqlLayer: 'SQL belongs in the owning Repository, not routes or Services.',
      table: '{{module}} Repository cannot implement SQL for table {{table}}.',
    },
  },
  create(context) {
    const filename = context.filename;
    const localPath = sourcePath(filename);
    const owner = localPath.split('/')[0];
    const isBusiness = Object.hasOwn(tables, owner);
    const isTest = /\.test\.ts$/.test(filename) || localPath.startsWith('testing/');
    const isRepository = localPath === owner + '/repository.ts';
    const isService = localPath === owner + '/service.ts';
    const isTransport = owner === 'routes' || owner === 'http';
    const privateImports = new Set();

    function checkImport(node, source, exporting = false) {
      if (typeof source !== 'string') return;
      if (!isTest && isBusiness && (source === 'hono' || source.startsWith('hono/'))) {
        context.report({ node, messageId: 'reverse' });
      }
      if (!isTest && (isBusiness || isTransport) && source === 'node:sqlite') {
        const typeOnly = node.importKind === 'type'
          || (node.specifiers?.length && node.specifiers.every(item => item.importKind === 'type'));
        if (isTransport || !typeOnly) context.report({ node, messageId: 'lifecycle' });
      }
      if (!source.startsWith('.')) return;
      const target = sourcePath(resolve(dirname(filename), source)).replace(/\.js$/, '.ts');
      const targetOwner = target.split('/')[0];
      const repository = target === targetOwner + '/repository.ts';
      if (repository && (exporting || targetOwner !== owner || (!isService && !isTest))) {
        context.report({ node, messageId: 'repository' });
        return;
      }
      if (repository && node.specifiers) {
        for (const specifier of node.specifiers) privateImports.add(specifier.local.name);
      }
      if (isTest) return;
      const targetService = target === targetOwner + '/service.ts';
      if (isBusiness && (targetOwner === 'routes' || targetOwner === 'http'
        || ['app.ts', 'server.ts', 'services.ts'].includes(target))) {
        context.report({ node, messageId: 'reverse' });
        return;
      }
      if (isRepository && targetService) {
        context.report({ node, messageId: 'reverse' });
        return;
      }
      if ((isTransport && targetOwner === 'database') || (isService && targetOwner === 'database' && node.importKind !== 'type')) {
        context.report({ node, messageId: 'storage' });
        return;
      }
      if (Object.hasOwn(tables, targetOwner) && targetOwner !== owner) {
        if (isRepository) context.report({ node, messageId: 'reverse' });
        else if (!targetService) context.report({ node, messageId: 'module' });
      }
    }

    function checkSqlText(node, value) {
      if (!isRepository || typeof value !== 'string' || !/\b(?:SELECT|FROM|JOIN|INSERT|INTO|UPDATE|DELETE)\b/i.test(value)) return;
      for (const table of businessTables) {
        if (tables[owner]?.includes(table)) continue;
        if (new RegExp('\\b' + table + '\\b', 'i').test(value)) {
          context.report({ node, messageId: 'table', data: { module: owner, table } });
        }
      }
    }

    return {
      ImportDeclaration: node => checkImport(node, node.source.value),
      ExportNamedDeclaration(node) {
        if (node.source) checkImport(node, node.source.value, true);
        else for (const specifier of node.specifiers) {
          if (privateImports.has(specifier.local.name)) context.report({ node, messageId: 'repository' });
        }
      },
      ExportAllDeclaration: node => checkImport(node, node.source.value, true),
      ImportExpression: node => checkImport(node, node.source.value),
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'require') {
          checkImport(node, node.arguments[0]?.value);
        }
        if (isTest || owner === 'database' || callee.type !== 'MemberExpression') return;
        const method = callee.computed ? callee.property.value : callee.property.name;
        if ((isService || isRepository) && method === 'close') {
          const receiver = callee.object.type === 'MemberExpression' ? callee.object.property.name : callee.object.name;
          if (['db', 'database'].includes(receiver)) context.report({ node, messageId: 'lifecycle' });
        }
        if (isRepository || (method !== 'prepare' && method !== 'exec')) return;
        if (method === 'exec' && callee.object.type === 'Literal' && callee.object.regex) return;
        context.report({ node, messageId: 'sqlLayer' });
      },
      Literal: node => checkSqlText(node, node.value),
      TemplateElement: node => checkSqlText(node, node.value.cooked),
    };
  },
};

export default [
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { architecture: { rules: { boundaries } } },
    rules: { 'architecture/boundaries': 'error' },
  },
];
