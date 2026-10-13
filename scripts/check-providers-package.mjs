/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:providers-package.')
const plan = familyVerificationPlan(['diagnostics', 'providers'])
console.log('Providers verification:', JSON.stringify(plan))
if (!plan.tests.includes('providers')) process.exit(0)
const work = mkdtempSync(join(tmpdir(), 'providers-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = isolatedPackageEnvironment()
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const tarballs = {}
  for (const name of ['diagnostics', 'providers']) {
    const source = join(work, name)
    mkdirSync(source)
    for (const file of [
      'src',
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'vitest.config.ts',
      'tsc.cjs',
      'README.md',
      'LICENSE',
      ...(name === 'providers' ? ['test', 'test-ownership.md'] : [])
    ])
      cpSync(join(root, 'packages', name, file), join(source, file), { recursive: true })
    // npm install saves the archive spec locally; restore the publishable version declaration before pack.
    const manifest = readFileSync(join(source, 'package.json'), 'utf8')
    npm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...offline,
        ...(name === 'providers' ? [tarballs.diagnostics] : [])
      ],
      source
    )
    writeFileSync(join(source, 'package.json'), manifest)
    npm(['run', 'build'], source)
    npm(['run', 'typecheck'], source)
    // Upstream builds do not rerun unchanged upstream unit suites.
    if (name === 'providers') npm(['test'], source)
    const packed = JSON.parse(
      execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], {
        cwd: source,
        env,
        encoding: 'utf8'
      })
    )[0]
    tarballs[name] = join(work, packed.filename)
    for (const { path } of packed.files) {
      assert.match(path, /^(?:dist\/|README\.md$|test-ownership\.md$|LICENSE$|package\.json$)/)
      assert.ok(!/\.test\./.test(path), `Packed test: ${path}`)
      if (/\.(?:js|ts)$/.test(path)) {
        const text = readFileSync(join(source, path), 'utf8')
        for (const forbidden of [
          root,
          'src/main/',
          'src/shared/',
          '@renderer/',
          'test/setup',
          "from 'electron'",
          'require("electron")'
        ])
          assert.ok(!text.includes(forbidden), `${path} references ${forbidden}`)
      }
    }
  }
  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@aipoch/providers': `file:${tarballs.providers}`,
        '@aipoch/diagnostics': `file:${tarballs.diagnostics}`
      },
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1', esbuild: '^0.25.0' }
    })
  )
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  for (const name of ['diagnostics', 'providers']) {
    const installed = realpathSync(join(consumer, 'node_modules/@aipoch', name))
    assert.ok(
      installed.startsWith(realpathSync(consumer) + sep),
      `External dependency link: ${installed}`
    )
    rmSync(join(work, name), { recursive: true })
  }
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import * as catalog from '@aipoch/providers/catalog'
import * as protocol from '@aipoch/providers/protocol'
import * as client from '@aipoch/providers/client'
const require = createRequire(import.meta.url)
for (const [entry, esm] of Object.entries({ catalog, protocol, client })) {
  assert.ok(realpathSync(require.resolve('@aipoch/providers/' + entry)).startsWith(realpathSync('.') + sep))
  const cjs = require('@aipoch/providers/' + entry)
  for (const key of Object.keys(cjs)) assert.equal(cjs[key], (esm as Record<string, unknown>)[key])
}
for (const entry of ['', '/package.json', '/dist/client.js', '/src/provider-registry', '/provider-text-generation']) {
  assert.throws(() => require('@aipoch/providers' + entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  await assert.rejects(import('@aipoch/providers' + entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
assert.equal(catalog.getOfficialVendor('openai')?.id, 'openai')
assert.equal(catalog.isSecureProviderUrl(new URL('http://example.test')), false)
assert.equal(protocol.openAiChatCompletionsUrl({ baseUrl: 'https://example.test/proxy' }), 'https://example.test/proxy/v1/chat/completions')
assert.equal(protocol.responsesToChatRequest({input:'Hello'}, 'model').model, 'model')
assert.deepEqual(protocol.normalizeOpenAiChatModelStepUsage({prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 3}}), {inputTokens:7,cacheTokens:3,cachedReadTokens:3,cachedWriteTokens:0,outputTokens:2})
const target: client.ProviderTextGenerationTarget = {providerId:'local',model:'m',provider:{type:'custom',baseUrl:'http://127.0.0.1:9090',apiEndpoints:['openai']}}
const service = new client.ProviderTextGenerationService(async (url, init) => {
  assert.equal(url, 'http://127.0.0.1:9090/v1/chat/completions'); assert.equal(init?.redirect,'manual')
  return Response.json({choices:[{finish_reason:'stop',message:{content:'Installed consumer'}}]})
})
assert.deepEqual(await service.run({target,systemPrompt:'Answer',prompt:'Hello',signal:new AbortController().signal,maxOutputTokens:16,outputLimitBytes:1024}),{text:'Installed consumer',stopReason:'end_turn'})
assert.equal(client.providerTextGenerationTargetKey(target).length,64)
const body = new Response('bounded')
assert.equal(await protocol.readBoundedResponseText(body, 32, 'consumer'), 'bounded')
console.log('PASS installed providers CJS/ESM identities, exports, types, protocol and client')
`
  )
  writeFileSync(
    join(consumer, 'consumer.cts'),
    `
import catalog = require('@aipoch/providers/catalog')
import protocol = require('@aipoch/providers/protocol')
import client = require('@aipoch/providers/client')
const endpoint: catalog.ChatApiEndpoint = 'openai'
const config: client.ProviderTextGenerationConfiguration = { type:'custom', apiEndpoints:[endpoint] }
const usage: protocol.ProviderTokenUsage = {inputTokens:1,cacheTokens:0,outputTokens:2}
void config; void usage
`
  )
  run(
    [
      'node_modules/typescript/bin/tsc',
      'consumer.mts',
      'consumer.cts',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict'
    ],
    consumer
  )
  writeFileSync(
    join(consumer, 'browser.mjs'),
    `import { getOfficialVendor, providerTextGenerationFailure, resolveReasoningEffortValue } from '@aipoch/providers/catalog'; globalThis.providerCatalog = {getOfficialVendor,providerTextGenerationFailure,resolveReasoningEffortValue};`
  )
  run(
    [
      '--input-type=module',
      '-e',
      "import {build} from 'esbuild'; await build({entryPoints:['browser.mjs'],bundle:true,platform:'browser',outfile:'browser-bundle.js'})"
    ],
    consumer
  )
  npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  run(['consumer.mjs'], consumer)
  run(['consumer.cjs'], consumer)
  run(['browser-bundle.js'], consumer)
} finally {
  rmSync(work, { recursive: true, force: true })
}
