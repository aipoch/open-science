/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:resilient-download-package.')
const plan = familyVerificationPlan(['resilient-download'])
console.log('Resilient download verification:', JSON.stringify(plan))
if (!plan.tests.length) process.exit(0)
const work = mkdtempSync(join(tmpdir(), 'resilient-download-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = isolatedPackageEnvironment()
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const source = join(work, 'source')
  mkdirSync(source)
  for (const file of [
    'src',
    'test',
    'package.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'vitest.config.ts',
    'tsc.cjs',
    'README.md',
    'LICENSE'
  ])
    cpSync(join(root, 'packages/resilient-download', file), join(source, file), { recursive: true })
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], source)
  npm(['run', 'build'], source)
  npm(['run', 'typecheck'], source)
  if (!process.argv.includes('--skip-tests')) npm(['test'], source)
  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], {
      cwd: source,
      env,
      encoding: 'utf8'
    })
  )[0]
  for (const { path } of packed.files) {
    assert.match(path, /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/)
    assert.ok(!/\.test\./.test(path), `Packed test: ${path}`)
    if (/\.(?:js|ts)$/.test(path)) {
      const text = readFileSync(join(source, path), 'utf8')
      for (const forbidden of [
        root,
        'src/main/',
        'src/shared/',
        '@renderer/',
        'test/setup',
        'i18next',
        'electron'
      ])
        assert.ok(!text.includes(forbidden), `${path} references ${forbidden}`)
    }
  }
  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  cpSync(join(source, 'test/transport.mjs'), join(consumer, 'transport.mjs'))
  rmSync(source, { recursive: true })
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@aipoch/resilient-download': `file:${join(work, packed.filename)}` },
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1' }
    })
  )
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import * as api from '@aipoch/resilient-download'
const require = createRequire(import.meta.url)
const cjs: typeof api = require('@aipoch/resilient-download')
assert.ok(realpathSync(require.resolve('@aipoch/resilient-download')).startsWith(process.cwd() + sep))
for (const key of Object.keys(cjs) as Array<keyof typeof api>) assert.equal(cjs[key], api[key])
assert.deepEqual(Object.keys(cjs).sort(), ['DownloadChecksumError', 'DownloadSourceError', 'SpeedMeter', 'resilientDownload'].sort())
assert.ok(new cjs.DownloadChecksumError() instanceof api.DownloadSourceError)
for (const path of ['/dist/index.js', '/src/index', '/resilient-download', '/errors', '/types']) {
  assert.throws(() => require('@aipoch/resilient-download' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  await assert.rejects(import('@aipoch/resilient-download' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
const progress: api.DownloadProgress = {phase: 'reconnecting', transferred: 4, bytesPerSecond: 0, attempt: 1}
const options: api.ResilientDownloadOpts = {fetchImpl: fetch, onProgress: value => assert.equal(typeof value.attempt, 'number')}
// @ts-expect-error Filesystem fault injection is not a published option.
const privateOptions: api.ResilientDownloadOpts = {deps: {}}
void progress; void options; void privateOptions
let now = 0
const meter = new api.SpeedMeter({now: () => now})
meter.record(0); now = 1000; meter.record(10)
assert.equal(meter.bytesPerSecond(), 10); assert.equal(meter.etaSeconds(20), 1)
`
  )
  writeFileSync(
    join(consumer, 'consumer.cts'),
    `
import api = require('@aipoch/resilient-download')
const options: api.ResilientDownloadOpts = {fetchImpl: fetch}
const download: (url: string, target: string, opts?: api.ResilientDownloadOpts) => Promise<string> = api.resilientDownload
void options; void download
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
    join(consumer, 'transport-consumer.mjs'),
    `
import * as api from '@aipoch/resilient-download'
import { verifyTransport } from './transport.mjs'
await Promise.all(['complete', 'resume', 'checksum', 'cancel', 'origin', 'stall'].map(scenario => verifyTransport(api, scenario)))
console.log('PASS: installed resilient-download transport, guarded resume, integrity, cancellation, origins and stall cleanup')
`
  )
  npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  run(['consumer.mjs'], consumer)
  run(['consumer.cjs'], consumer)
  run(['transport-consumer.mjs'], consumer)
} finally {
  rmSync(work, { recursive: true, force: true })
}
