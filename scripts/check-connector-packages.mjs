/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Build and test copied packages, then consume their tarballs outside the repository.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check through npm run check:connector-packages.')
const temporary = mkdtempSync(join(tmpdir(), 'connector-packages-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = { ...process.env, NODE_PATH: '', npm_config_cache: join(temporary, 'cache') }
// An explicit cache may supply offline dependencies, never node_modules or source resolution.
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit' })
const npmRun = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd)

try {
  const tarballs = []
  for (const name of ['connector-core', 'connector-builtins', 'connector-mcp-client']) {
    const directory = join(temporary, name)
    mkdirSync(directory)
    for (const file of [
      'src',
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'vitest.config.ts',
      'README.md',
      'LICENSE',
      'tsc.cjs'
    ]) {
      cpSync(join(root, 'packages', name, file), join(directory, file), { recursive: true })
    }
    npmRun(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...offline,
        ...(tarballs.length ? ['--no-save', tarballs[0]] : [])
      ],
      directory
    )
    npmRun(['run', 'typecheck'], directory)
    npmRun(['test'], directory)
    npmRun(['pack', '--pack-destination', temporary], directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    tarballs.push(join(temporary, `aipoch-${name}-${manifest.version}.tgz`))
  }

  const consumer = join(temporary, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1' }
    })
  )
  npmRun(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline, ...tarballs],
    consumer
  )
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { ConnectorArgumentsError, ConnectorHttpError, ParserEngine, createConnectorRegistry } from '@aipoch/connector-core'
import type { ConnectorCredentials, ToolDescriptor } from '@aipoch/connector-core'
import { PUBMED_TOOLS } from '@aipoch/connector-builtins/pubmed'
import { OPENALEX_LITERATURE_TOOLS } from '@aipoch/connector-builtins/literature-openalex'
import { CELLOSAURUS_TOOLS } from '@aipoch/connector-builtins/cellosaurus'
import { ncbiEtiquette } from '@aipoch/connector-builtins/ncbi'
import { createEncoriTools } from '@aipoch/connector-builtins/encori'
import { renderMoleculeStructure } from '@aipoch/connector-builtins/molecule-render'
import { McpClientManager, buildTransport } from '@aipoch/connector-mcp-client'
import { normalizeLoopbackOAuthRedirectUri } from '@aipoch/connector-mcp-client/oauth-redirect'
import { isSecureRemoteUrl } from '@aipoch/connector-core/url-admission'
${Object.keys(
  JSON.parse(readFileSync(join(root, 'packages/connector-builtins/package.json'), 'utf8')).exports
)
  .map(
    (entry, i) =>
      `import * as provider${i} from '@aipoch/connector-builtins/${entry.slice(2)}'\nvoid provider${i}`
  )
  .join('\n')}


const require = createRequire(import.meta.url)
assert.equal(require('@aipoch/connector-core').ConnectorHttpError, ConnectorHttpError)
assert.equal(require('@aipoch/connector-core').ConnectorArgumentsError, ConnectorArgumentsError)
assert.equal(require('@aipoch/connector-builtins/cellosaurus').CELLOSAURUS_TOOLS, CELLOSAURUS_TOOLS)
assert.ok(realpathSync(require.resolve('@aipoch/connector-core')).startsWith(process.cwd()))
assert.deepEqual(Object.keys(require('@aipoch/connector-core')).sort(), [
  'CONNECTOR_RETRYABLE_STATUS', 'ConnectorArgumentsError', 'ConnectorHttpError', 'ParserEngine',
  'abortableDelay', 'boundedExponentialBackoff', 'connectorRetryDelay', 'createConnectorRegistry', 'withTimeoutSignal'
].sort())
for (const hidden of ['@aipoch/connector-core/diagnostics', '@aipoch/connector-core/src/engine', '@aipoch/connector-core/dist/engine.js', '@aipoch/connector-builtins', '@aipoch/connector-builtins/src/pubmed', '@aipoch/connector-mcp-client/src/client-manager', '@aipoch/connector-mcp-client/dist/client-manager.js']) {
  assert.throws(() => require(hidden), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
// Public declaration consumption and a custom provider with caller-owned configuration.
const credentials: ConnectorCredentials = { customKey: 'secret' }
const custom: ToolDescriptor = {
  connector: 'custom', id: 'read', description: 'Read',
  input: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  run: (ctx, args) => ctx.fetchJson('https://example.org/' + args.id + '?key=' + ctx.credentials.customKey)
}
const registry = createConnectorRegistry([...PUBMED_TOOLS, ...OPENALEX_LITERATURE_TOOLS, ...CELLOSAURUS_TOOLS, custom])
assert.equal(registry.getDescriptor('custom', 'read'), custom)
registry.validateToolArguments(custom, { id: 1 })
assert.throws(() => registry.validateToolArguments(custom, { id: '1' }), ConnectorArgumentsError)
assert.deepEqual(await new ParserEngine({ fetchImpl: async (url) => {
  assert.equal(String(url), 'https://example.org/1?key=secret')
  return Response.json({ ok: true })
} }).call(custom, { id: 1 }, credentials), { ok: true })
assert.equal(ncbiEtiquette({ ncbiEmail: 'a@b.org' }), '&email=a%40b.org')
assert.ok(OPENALEX_LITERATURE_TOOLS.every(tool => tool.connector === 'literature'))
// The implementation catches the engine's 404 class across the package boundary.
let calls = 0
const engine = new ParserEngine({ retries: 0, fetchImpl: async () => {
  calls++
  return calls === 1 ? new Response('missing', { status: 404 }) : Response.json({ Cellosaurus: { 'cell-line-list': [] } })
} })
await assert.rejects(engine.call(registry.getDescriptor('cellosaurus', 'get_cell_line')!, { accession: 'CVCL_1906' }, {}), ConnectorHttpError)
assert.equal(calls, 2)
assert.equal(require('@aipoch/connector-mcp-client').McpClientManager, McpClientManager)
assert.equal(isSecureRemoteUrl('http://example.org/mcp'), false)
assert.equal(normalizeLoopbackOAuthRedirectUri('http://127.0.0.1/oauth/callback'), 'http://127.0.0.1/oauth/callback')
assert.ok(createEncoriTools(async () => { throw new Error('No filesystem in this consumer') }).length > 0)
assert.ok(buildTransport({ id: 'custom', name: 'custom', transport: 'stdio', command: 'unused' }))
const molecule = await renderMoleculeStructure({ smiles: 'CCO' })
assert.ok(molecule)
console.log('Independent Connector tarballs: types, exports, CJS/ESM identity and execution passed.')
`
  )
  run(
    process.execPath,
    [
      join(consumer, 'node_modules/typescript/bin/tsc'),
      'consumer.mts',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--skipLibCheck'
    ],
    consumer
  )
  // Remove the copied build/test trees before consuming, so no sibling source is available.
  for (const name of ['connector-core', 'connector-builtins', 'connector-mcp-client'])
    rmSync(join(temporary, name), { recursive: true })
  run(process.execPath, ['consumer.mjs'], consumer)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
