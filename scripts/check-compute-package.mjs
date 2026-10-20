/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plan = familyVerificationPlan(['diagnostics', 'compute'])
if (!plan.tests.includes('compute')) process.exit(0)
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:compute-package')
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const isolated = await mkdtemp(join(tmpdir(), 'compute-isolation-'))
const archives = join(isolated, 'archives')
await mkdir(archives)
const env = {
  ...isolatedPackageEnvironment(),
  ...(!offline.length
    ? { npm_config_cache: process.env.npm_config_cache ?? join(isolated, 'npm-cache') }
    : {})
}
const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
async function seedLock(directory, manifest) {
  const lock = structuredClone(rootLock)
  lock.name = manifest.name ?? 'consumer'
  lock.version = manifest.version ?? '0.0.0'
  lock.packages[''] = manifest
  for (const key of Object.keys(lock.packages))
    if (key.startsWith('packages/') || lock.packages[key].link) delete lock.packages[key]
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2))
}
async function run(command, args, cwd, label) {
  const chunks = []
  const status = await new Promise((done, reject) => {
    const npmArgs =
      command === 'npm'
        ? [npmCli, ...args, ...(['install', 'prune'].includes(args[0]) ? offline : [])]
        : args
    const child = spawn(command === 'npm' ? process.execPath : command, npmArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => chunks.push(d))
    child.on('error', reject)
    child.on('exit', done)
  })
  const output = Buffer.concat(chunks).toString()
  await writeFile(join(isolated, label + '.log'), output)
  if (status !== 0) {
    console.error(output.slice(-12000))
    throw Error(`${label} failed (${status}); evidence: ${isolated}`)
  }
  return output
}
const packed = {}
const sources = []
for (const name of plan.builds) {
  const source = join(isolated, 'source-' + name)
  sources.push(source)
  await cp(join(root, 'packages', name), source, {
    recursive: true,
    filter: (p) => !['dist', 'node_modules', '.git'].includes(basename(p))
  })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const installing = structuredClone(manifest)
  for (const [name, archive] of Object.entries(packed))
    if (installing.dependencies?.[name]) installing.dependencies[name] = 'file:' + archive
  await writeFile(join(source, 'package.json'), JSON.stringify(installing, null, 2))
  await seedLock(source, installing)
  await run('npm', ['install', '--no-audit', '--no-fund'], source, name + '-install')
  await run('npm', ['run', 'build'], source, name + '-build')
  await run('npm', ['run', 'typecheck'], source, name + '-typecheck')
  if (plan.tests.includes(name)) await run('npm', ['test'], source, name + '-test')
  // Pack the declared package, never temporary file: dependency coordinates.
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest, null, 2))
  const output = await run(
    'npm',
    ['pack', '--json', '--pack-destination', archives],
    source,
    name + '-pack'
  )
  const metadata = JSON.parse(output.slice(output.indexOf('[\n')))[0]
  packed[manifest.name] = join(archives, metadata.filename)
  console.log(
    name +
      ': isolated source install, build, types and npm pack passed' +
      (plan.tests.includes(name) ? '; tests passed' : '; prerequisite tests not selected')
  )
}
const consumer = join(isolated, 'consumer')
await mkdir(consumer)
const manifest = {
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(Object.entries(packed).map(([k, v]) => [k, 'file:' + v])),
  devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1' }
}
await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
await seedLock(consumer, manifest)
await run('npm', ['install', '--no-audit', '--no-fund'], consumer, 'consumer-install')
for (const name of Object.keys(packed))
  assert.ok(
    (await realpath(join(consumer, 'node_modules', name))).startsWith(
      (await realpath(consumer)) + sep
    )
  )
await cp(
  join(root, 'packages/compute/test/packed-runtime.mjs'),
  join(consumer, 'packed-runtime.mjs')
)
const types = `import { computeProviderId, type ComputeJob, type ComputeJobRepository } from '@aipoch/compute';\nimport { createComputeExecution } from '@aipoch/compute/node';\nconst id: string = computeProviderId('cluster');\nconst runtime = createComputeExecution();\nconst finish: () => void = runtime.holdDispatch(id); finish();\nconst check = (job: ComputeJob, store: ComputeJobRepository) => store.get(job.job_id); void check;\n`
for (const extension of ['mts', 'cts']) {
  await writeFile(join(consumer, 'check.' + extension), types)
  await run(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      'check.' + extension
    ],
    consumer,
    'consumer-types-' + extension
  )
}
for (const source of sources) await rm(source, { recursive: true, force: true })
await run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], consumer, 'consumer-prune')
await run(
  process.execPath,
  ['packed-runtime.mjs'],
  consumer,
  'consumer-runtime-after-source-removal'
)
await writeFile(
  join(isolated, 'result.json'),
  JSON.stringify(
    {
      passed: true,
      packed,
      sourceRemoved: true,
      consumer,
      formats: ['CJS', 'ESM'],
      node: process.version
    },
    null,
    2
  )
)
console.log(`Compute isolation passed. Evidence: ${isolated}`)
