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
if (!npmCli) throw new Error('Run through npm run check:durable-files-package.')
const plan = familyVerificationPlan(['durable-files', 'skills', 'specialists'])
console.log('Durable file consumers:', JSON.stringify(plan))
if (!plan.tests.length) process.exit(0)
const work = mkdtempSync(join(tmpdir(), 'durable-files-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = isolatedPackageEnvironment()
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const source = join(work, 'source')
  mkdirSync(source)
  for (const file of [
    'src',
    'package.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'vitest.config.ts',
    'tsc.cjs',
    'README.md',
    'LICENSE'
  ])
    cpSync(join(root, 'packages/durable-files', file), join(source, file), { recursive: true })
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], source)
  npm(['run', 'build'], source)
  if (plan.tests.includes('durable-files')) {
    npm(['run', 'typecheck'], source)
    if (!process.argv.includes('--skip-tests')) npm(['test'], source)
  }
  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], {
      cwd: source,
      env,
      encoding: 'utf8'
    })
  )[0]
  for (const { path } of packed.files) {
    assert.match(path, /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/)
    if (/\.(?:js|ts)$/.test(path)) {
      const text = readFileSync(join(source, path), 'utf8')
      for (const forbidden of [root, 'src/main/', 'src/shared/', '@renderer/', 'test/setup'])
        assert.ok(!text.includes(forbidden), `${path} references ${forbidden}`)
      assert.ok(!/\.test\./.test(path), `Packed test: ${path}`)
    }
  }
  const tarball = join(work, packed.filename)
  // Nothing executed below can resolve the source build or its development dependencies.
  rmSync(source, { recursive: true })
  if (plan.tests.includes('durable-files')) {
    const consumer = join(work, 'consumer')
    mkdirSync(consumer)
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { '@aipoch/durable-files': `file:${tarball}` },
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
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import * as files from '@aipoch/durable-files'
import type { DurableJsonFileDependencies, FileDurability } from '@aipoch/durable-files'
const require = createRequire(import.meta.url)
const cjs: typeof files = require('@aipoch/durable-files')
assert.ok(realpathSync(require.resolve('@aipoch/durable-files')).startsWith(process.cwd() + sep))
for (const key of Object.keys(cjs) as Array<keyof typeof files>) assert.equal(cjs[key], files[key])
for (const path of ['/dist/index.js', '/src/index', '/durable-json-file', '/file-durability']) {
  assert.throws(() => require('@aipoch/durable-files' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  await assert.rejects(import('@aipoch/durable-files' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
const durability: FileDurability = files.createFileDurability()
const directory = await mkdtemp(join(process.cwd(), 'data-'))
try {
  const path = join(directory, 'document.json')
  const dependencies: Partial<DurableJsonFileDependencies> = { createTemporarySuffix: () => '1700000000000-1' }
  await Promise.all([files.writeDurableJsonFile(path, '{"value":1}', dependencies), cjs.writeDurableJsonFile(path, '{"value":2}', dependencies)])
  assert.deepEqual(await files.readDurableJsonFile(path, JSON.parse), { status: 'found', value: { value: 2 } })
  await assert.rejects(files.readFileWithinLimit(path, 1), (error: unknown) => error instanceof cjs.DurableJsonReadLimitError && error instanceof files.DurableJsonRecoveryBarrierError)
  await durability.syncFile(path)
  await durability.syncDirectory(directory)
  await rm(path)
  await writeFile(path + '.1700000000000-1.tmp', '{"version":1}')
  await writeFile(path + '.1700000000000-2.tmp', '{"version":2}')
  const decode = (text: string): { version: number } => { const value = JSON.parse(text); if (value.version === 2) throw new cjs.DurableJsonRecoveryBarrierError('future'); return value }
  await assert.rejects(files.readDurableJsonFile(path, decode), files.DurableJsonRecoveryBarrierError)
  assert.equal((await readdir(directory)).length, 2)
  await rm(path + '.1700000000000-2.tmp')
  await files.recoverDurableJsonDirectory(directory, (_path, text) => JSON.parse(text))
  assert.equal(await readFile(path, 'utf8'), '{"version":1}')
  await writeFile(path, '{')
  await writeFile(path + '.1700000000000-1.tmp', '{}')
  await assert.rejects(files.readDurableJsonFile(path, JSON.parse), SyntaxError)
  assert.equal(await readFile(path, 'utf8'), '{')
  assert.equal(files.isRecoverableDurableJsonTemporaryFile(path, 'document.json.' + process.pid + '.tmp'), true)
  assert.equal(files.isRecoverableDurableJsonTemporaryFile(path, 'document.json.' + process.pid + '-12345678-1234-1234-1234-123456789abc.tmp'), false)
  let attempts = 0
  await files.retryFileReplacement(async () => { if (++attempts === 1) throw Object.assign(new Error('busy'), {code:'EBUSY'}) }, async () => {})
  assert.equal(attempts, 2)
} finally { await rm(directory, {recursive:true, force:true}) }
console.log('PASS: installed durable-files types, identity, queue, publication, recovery, barriers and private exports')
`
    )
    writeFileSync(
      join(consumer, 'consumer.cts'),
      `
import files = require('@aipoch/durable-files')
const durability: files.FileDurability = files.defaultFileDurability
const dependencies: Partial<files.DurableJsonFileDependencies> = {}
void durability; void dependencies
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
        '--strict',
        '--skipLibCheck'
      ],
      consumer
    )
    npm(
      ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline],
      consumer
    )
    run(['consumer.mjs'], consumer)
    run(['consumer.cjs'], consumer)
  }
  for (const name of ['skills', 'specialists']) {
    if (!plan.tests.includes(name)) continue
    run(
      [
        join(root, 'packages', name, 'scripts/verify-package.mjs'),
        `--durable-files-tarball=${tarball}`,
        ...(process.argv.includes('--skip-tests') ? ['--skip-tests'] : []),
        ...offline
      ],
      root
    )
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
