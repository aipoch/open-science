/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:environment-package.')
const plan = familyVerificationPlan(['diagnostics', 'environment'])
console.log('Environment package verification:', JSON.stringify(plan))
if (!plan.tests.includes('environment')) process.exit(0)
const temporary = mkdtempSync(join(tmpdir(), 'environment-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = {
  ...isolatedPackageEnvironment(),
  ...(!offline.length
    ? { npm_config_cache: process.env.npm_config_cache ?? join(temporary, 'cache') }
    : {})
}
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const tarballs = []
  for (const name of plan.builds) {
    const directory = join(temporary, name)
    mkdirSync(directory)
    for (const file of [
      'src',
      'package.json',
      'tsconfig.json',
      'tsc.cjs',
      'README.md',
      'LICENSE',
      ...(name === 'environment' ? ['tsconfig.test.json', 'vitest.config.ts'] : [])
    ]) {
      cpSync(join(root, 'packages', name, file), join(directory, file), { recursive: true })
    }
    npm(
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
    if (name === 'environment') {
      npm(['run', 'typecheck'], directory)
      if (plan.tests.includes(name) && !process.argv.includes('--skip-tests'))
        npm(['test'], directory)
    }
    npm(['pack', '--pack-destination', temporary], directory)
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
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline, ...tarballs], consumer)
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EnvironmentLeaseManager, EnvironmentStateTracker, installPackages, parseNotebookEnvironmentLock, decodeNotebookEnvironmentLock, validateNotebookHelperExports } from '@aipoch/environment'
import type { NotebookEnvironmentManifest } from '@aipoch/environment/contracts'
const require = createRequire(import.meta.url)
assert.ok(realpathSync(require.resolve('@aipoch/environment')).startsWith(process.cwd()))
assert.equal(require('@aipoch/environment').EnvironmentLeaseManager, EnvironmentLeaseManager)
for (const entry of ['/src/index', '/dist/index.js', '/package-manager']) {
  assert.throws(() => require('@aipoch/environment' + entry), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
}
assert.deepEqual(decodeNotebookEnvironmentLock('{"schemaVersion":3}'), {status:'unsupported',version:3})
assert.throws(() => parseNotebookEnvironmentLock('{}'), /schema is invalid/)
const leases = new EnvironmentLeaseManager()
const first = await leases.acquire('analysis', 'shared').granted
let granted = false
const queued = leases.acquire('analysis', 'exclusive').granted.then(lease => { granted = true; return lease })
await Promise.resolve()
assert.equal(granted, false)
first.release()
;(await queued).release()
leases.dispose()
const tracker = new EnvironmentStateTracker({dataRoot:process.cwd(), inspectInstalled:async () => ({runtimeVersion:'3.12',packages:[]}), captureFingerprint:async () => 'stable'})
const capture = await tracker.captureCompletedRun({language:'python',environmentName:'external',runtimeSource:'external',command:'/external/python'}, {packages:[],executionContext:{consumer:'independent'}})
const manifest: NotebookEnvironmentManifest<{consumer:string}> = capture.manifest
assert.equal(manifest.executionContext?.consumer, 'independent')
assert.deepEqual(JSON.parse(await readFile(capture.storagePath,'utf8')), manifest)
const installed = await installPackages({language:'python',packages:['example'],usePip:true},{storageRoot:process.cwd(),interpreter:{command:'python'},spawn:async () => ({code:0,stdout:'installed',stderr:''})})
assert.equal(installed.ok,true)
await validateNotebookHelperExports('isolated-consumer', 'def value(): return 42', ['value'])
console.log('Independent environment tarball: exports, types, leases, manifest persistence and injected installation passed.')
`
  )
  run(
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
  for (const name of ['diagnostics', 'environment'])
    rmSync(join(temporary, name), { recursive: true })
  npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  run(['consumer.mjs'], consumer)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
