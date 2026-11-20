import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
const legacyRoot = fileURLToPath(new URL('../server/', import.meta.url));
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
const moduleOwner = path => /^modules\/([^/]+)\//.exec(path)?.[1] ?? null;
const composition = new Set(['app.ts', 'server.ts', 'services.ts', 'usecases.ts']);
const jsonTypes = new Set(['JsonObject', 'JsonValue']);

function typeOnly(node) {
  return node.importKind === 'type' || node.exportKind === 'type'
    || (node.specifiers?.length > 0 && node.specifiers.every(item => item.importKind === 'type' || item.exportKind === 'type'));
}
function importedName(specifier) {
  return specifier.imported?.name ?? specifier.imported?.value ?? specifier.local?.name;
}

const boundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      repository: 'Repository and stored row types are private to the owning module.',
      legacy: 'Server V2 cannot import original Server internals; migrate the required implementation.',
      infrastructure: 'Infrastructure cannot depend on business modules, usecases, HTTP or composition.',
      pi: 'Model infrastructure cannot depend on database or events infrastructure, and modules cannot perform model execution.',
      sdk: 'Only the pi adapter may import pi SDK types or implementations.',
      adapter: 'Business and transport code depend on the SDK-neutral model contract; concrete adapters belong in composition.',
      module: 'The only public business module entry is service.ts.',
      contextEntry: 'Context consumers must import only usecases/context/index.ts, including public types.',
      contextDependency: 'Context preparation cannot depend on other usecases or event transport infrastructure.',
      readonly: 'Cross-module module dependencies must be named type-only domain types or explicit Readers, never a full Service.',
      wildcard: 'Export explicit public types and capabilities; wildcard exports can leak module internals.',
      reverse: 'Modules cannot depend on usecases or HTTP/composition; usecases cannot depend on HTTP/composition.',
      storage: 'Database capabilities belong in Repositories; usecases may receive only TransactionRunner.',
      lifecycle: 'Only server/database infrastructure may open or close the database.',
      sqlLayer: 'SQL belongs in the owning Repository, not routes, usecases or Services.',
      table: '{{module}} Repository cannot implement SQL for table {{table}}.',
    },
  },
  create(context) {
    const filename = context.filename;
    const localPath = sourcePath(filename);
    const owner = moduleOwner(localPath);
    const isModule = owner !== null;
    const isTest = /\.test\.ts$/.test(filename) || localPath.startsWith('testing/');
    const isRepository = isModule && localPath === 'modules/' + owner + '/repository.ts';
    const isService = isModule && localPath === 'modules/' + owner + '/service.ts';
    const isTransport = /^(?:routes|http)\//.test(localPath);
    const isUsecase = localPath.startsWith('usecases/');
    const isContext = localPath.startsWith('usecases/context/');
    const isDatabase = localPath.startsWith('infrastructure/database/');
    const isInfrastructure = localPath.startsWith('infrastructure/');
    const isPi = localPath.startsWith('infrastructure/pi/');
    const isModel = localPath.startsWith('infrastructure/model/');
    const isServer = localPath === 'server.ts';
    const privateImports = new Set();

    function checkImport(node, source, exporting = false, explicitTypes) {
      if (typeof source !== 'string') return;
      const typesOnly = explicitTypes !== undefined || typeOnly(node);
      const names = explicitTypes ?? node.specifiers?.map(importedName) ?? [];
      if (source === '@sillyrealms/server' || source.startsWith('@sillyrealms/server/')) {
        context.report({ node, messageId: 'legacy' });
        return;
      }
      if (!isPi && (source === '@earendil-works/pi-ai' || source.startsWith('@earendil-works/pi-ai/'))) {
        context.report({ node, messageId: 'sdk' });
        return;
      }
      if (!isTest && (isModule || isUsecase || isInfrastructure) && (source === 'hono' || source.startsWith('hono/'))) {
        context.report({ node, messageId: 'reverse' });
      }
      if (!isTest && source === 'node:sqlite' && !isDatabase && !isServer) {
        if (isTransport || isUsecase || !typesOnly || (!isService && !isRepository && localPath !== 'services.ts')) {
          context.report({ node, messageId: 'lifecycle' });
        }
      }
      if (!source.startsWith('.') && !source.startsWith('/')) return;
      const targetPath = resolve(dirname(filename), source);
      if (targetPath.startsWith(legacyRoot)) {
        context.report({ node, messageId: 'legacy' });
        return;
      }
      const target = sourcePath(targetPath).replace(/\.js$/, '.ts');
      const targetContext = target === 'usecases/context' || target.startsWith('usecases/context/');
      if (!isContext && targetContext && target !== 'usecases/context/index.ts') {
        context.report({ node, messageId: 'contextEntry' });
        return;
      }
      const targetOwner = moduleOwner(target);
      const targetService = targetOwner !== null && target === 'modules/' + targetOwner + '/service.ts';
      const repository = targetOwner !== null && target === 'modules/' + targetOwner + '/repository.ts';
      if (repository && (exporting || targetOwner !== owner || (!isService && !isTest))) {
        context.report({ node, messageId: 'repository' });
        return;
      }
      if (repository && node.specifiers) {
        for (const specifier of node.specifiers) privateImports.add(specifier.local.name);
      }
      if (target.startsWith('infrastructure/pi/') && !isPi && !composition.has(localPath)) {
        context.report({ node, messageId: 'adapter' });
        return;
      }
      if (isTest) return;
      if (isContext && ((target.startsWith('usecases/') && !targetContext) || target.startsWith('infrastructure/events/'))) {
        context.report({ node, messageId: 'contextDependency' });
        return;
      }
      if (isInfrastructure && (targetOwner !== null || target.startsWith('usecases/') || /^(?:routes|http)\//.test(target) || composition.has(target))) {
        context.report({ node, messageId: 'infrastructure' });
        return;
      }
      if (((isPi || isModel) && /^infrastructure\/(?:database|events)\//.test(target))
        || (isModule && target.startsWith('infrastructure/model/') && (!typesOnly || names.includes('ModelClient')))) {
        context.report({ node, messageId: 'pi' });
        return;
      }
      if ((isModule && (target.startsWith('usecases/') || /^(?:routes|http)\//.test(target) || composition.has(target)))
        || (isUsecase && (/^(?:routes|http)\//.test(target) || composition.has(target)))
        || (isTransport && composition.has(target))) {
        context.report({ node, messageId: 'reverse' });
        return;
      }
      if (isRepository && targetService) {
        context.report({ node, messageId: 'reverse' });
        return;
      }
      if (target.startsWith('infrastructure/database/') && !isDatabase && !isServer) {
        if (names.includes('openDatabase')) {
          context.report({ node, messageId: 'lifecycle' });
          return;
        }
        if (isTransport) {
          context.report({ node, messageId: 'storage' });
          return;
        }
        if (isModule && !isRepository) {
          if (target !== 'infrastructure/database/connection.ts' || !typesOnly || !names.length || names.some(name => !jsonTypes.has(name))) {
            context.report({ node, messageId: 'storage' });
          }
          return;
        }
        if (isUsecase) {
          const json = target === 'infrastructure/database/connection.ts' && names.length > 0 && names.every(name => jsonTypes.has(name));
          const transaction = target === 'infrastructure/database/transaction.ts' && names.length === 1 && names[0] === 'TransactionRunner';
          if (!typesOnly || (!json && !transaction)) context.report({ node, messageId: 'storage' });
          return;
        }
      }
      if (targetOwner !== null && targetOwner !== owner) {
        if (isRepository) context.report({ node, messageId: 'reverse' });
        else if (!targetService) context.report({ node, messageId: 'module' });
        else if (isModule && (!typesOnly || !names.length
          || node.specifiers?.some(item => item.type !== 'ImportSpecifier' && item.type !== 'ExportSpecifier')
          || names.some(name => !name || /(?:Service|Repository|Row)$/.test(name)))) {
          context.report({ node, messageId: 'readonly' });
        }
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

    function privateExport(node, name) {
      if (privateImports.has(name)) context.report({ node, messageId: 'repository' });
    }

    return {
      ImportDeclaration: node => checkImport(node, node.source.value),
      'ExportNamedDeclaration:exit'(node) {
        if (node.source) checkImport(node, node.source.value, true);
        else {
          for (const specifier of node.specifiers) privateExport(node, specifier.local.name);
          if (node.declaration?.id) privateExport(node, node.declaration.id.name);
          if (node.declaration?.type === 'VariableDeclaration') {
            for (const item of node.declaration.declarations) {
              if (item.id.type === 'Identifier') privateExport(node, item.id.name);
            }
          }
        }
      },
      ExportAllDeclaration(node) {
        if (!isTest) context.report({ node, messageId: 'wildcard' });
        checkImport(node, node.source.value, true);
      },
      ExportDefaultDeclaration(node) {
        if (node.declaration.type === 'Identifier') privateExport(node, node.declaration.name);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init?.type === 'Identifier' && privateImports.has(node.init.name)) {
          privateImports.add(node.id.name);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type === 'TSTypeReference' && node.typeAnnotation.typeName.type === 'Identifier'
          && privateImports.has(node.typeAnnotation.typeName.name)) privateImports.add(node.id.name);
      },
      ImportExpression: node => checkImport(node, node.source.value),
      TSImportType(node) {
        const source = node.source.value;
        const name = node.qualifier?.type === 'Identifier' && !node.isTypeOf ? node.qualifier.name : undefined;
        checkImport(node, source, false, name ? [name] : []);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'require') checkImport(node, node.arguments[0]?.value);
        if (isTest || isDatabase || callee.type !== 'MemberExpression') return;
        const method = callee.computed ? callee.property.value : callee.property.name;
        if (!isServer && method === 'close') {
          const receiver = callee.object.type === 'MemberExpression' ? callee.object.property.name : callee.object.name;
          if (['db', 'database', 'connection'].includes(receiver)) context.report({ node, messageId: 'lifecycle' });
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
