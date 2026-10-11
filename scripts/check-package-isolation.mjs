/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, writeFile, mkdir, mkdtemp, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv.find((a) => a.startsWith('--output='))?.slice(9)
const evidence = output
  ? resolve(output)
  : await mkdtemp(join(tmpdir(), 'package-isolation-evidence-'))
await mkdir(evidence, { recursive: true })
process.chdir(root)
async function fingerprint(dir) {
  const hash = createHash('sha256')
  async function visit(p) {
    for (const entry of (await readdir(p, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const f = join(p, entry.name)
      hash.update(f.slice(dir.length))
      if (entry.isDirectory()) await visit(f)
      else hash.update(await readFile(f))
    }
  }
  await visit(dir)
  return hash.digest('hex')
}

const registry = JSON.parse(await readFile('scripts/ci/package-test-boundaries.json', 'utf8'))
const requested = process.argv
  .find((arg) => arg.startsWith('--packages='))
  ?.slice(11)
  .split(',')
const selected = registry.packages.filter(
  (entry) => !requested || requested.includes(entry.root.split('/').at(-1))
)
if (
  requested &&
  requested.some((name) => !selected.some((entry) => entry.root === 'packages/' + name))
)
  throw Error('Unknown package selection')
const entries = await Promise.all(
  selected.map(async (e) => ({
    ...e,
    manifest: JSON.parse(await readFile(join(e.root, 'package.json'), 'utf8'))
  }))
)
const inputHashes = Object.fromEntries(
  await Promise.all(entries.map(async (e) => [e.root, await fingerprint(join(root, e.root))]))
)
const lockHash = createHash('sha256')
  .update(await readFile(join(root, 'package-lock.json')))
  .digest('hex')
const resume = process.argv.includes('--resume')
const forced = new Set(
  (process.argv.find((a) => a.startsWith('--force=')) ?? '').slice(8).split(',').filter(Boolean)
)
const fresh = resume
  ? (await readFile(join(evidence, 'isolated-location.txt'), 'utf8')).trim()
  : await mkdtemp(join(tmpdir(), 'package-isolated-'))
await writeFile(join(evidence, 'isolated-location.txt'), fresh + '\n')
await mkdir(join(fresh, 'archives'), { recursive: true })
const report = resume
  ? JSON.parse(await readFile(join(evidence, 'isolated-report.json'), 'utf8'))
  : []
const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
async function seedLock(dir, manifest) {
  const lock = structuredClone(rootLock)
  lock.name = manifest.name ?? 'isolated-consumer'
  lock.version = manifest.version ?? '0.0.0'
  lock.packages[''] = { ...manifest }
  for (const key of Object.keys(lock.packages))
    if (key.startsWith('packages/') || lock.packages[key].link) delete lock.packages[key]
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2))
}
const cleanEnv = { ...process.env }
delete cleanEnv.NODE_PATH
delete cleanEnv.INIT_CWD
delete cleanEnv.NODE_OPTIONS
async function run(bin, args, cwd, label) {
  const out = []
  const code = await new Promise((done, reject) => {
    const p = spawn(bin, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => out.push(d))
    p.on('error', reject)
    p.on('exit', done)
  })
  const text = Buffer.concat(out).toString()
  await writeFile(join(evidence, label + '.log'), text)
  if (code !== 0) throw Error(label + ' exited ' + code)
  return text
}
const packed = new Map()
for (const e of entries) {
  const text = await run(
    'npm',
    ['pack', '--json', '--pack-destination', join(fresh, 'archives')],
    join(root, e.root),
    'pack-' + e.manifest.name.split('/')[1]
  )
  const start = text.indexOf('[\n')
  const meta = JSON.parse(text.slice(start))[0]
  packed.set(e.root, join(fresh, 'archives', meta.filename))
  if (!report.some((r) => r.package === e.manifest.name))
    report.push({ package: e.manifest.name, pack: meta, source: 'pending', consumer: 'pending' })
  else report.find((r) => r.package === e.manifest.name).pack = meta
  console.log('packed', e.manifest.name)
}
await writeFile(join(evidence, 'isolated-report.json'), JSON.stringify(report, null, 2))
function closure(e, seen = new Set()) {
  for (const r of e.dependencies)
    if (!seen.has(r)) {
      seen.add(r)
      closure(
        entries.find((x) => x.root === r),
        seen
      )
    }
  return seen
}
for (const e of entries) {
  const name = e.manifest.name.split('/')[1],
    r = report.find((x) => x.package === e.manifest.name)
  const inputs = {
    lockHash,
    packages: Object.fromEntries([e.root, ...closure(e)].map((p) => [p, inputHashes[p]]))
  }
  if (
    resume &&
    r.consumer === 'exports, declarations, private paths passed' &&
    !r.error &&
    !forced.has(name) &&
    JSON.stringify(r.inputs) === JSON.stringify(inputs)
  )
    continue
  r.inputs = inputs
  delete r.error
  r.source = 'pending'
  r.consumer = 'pending'
  try {
    const attempt = await mkdtemp(join(fresh, name + '-'))
    const dir = join(attempt, 'source')
    await mkdir(dir, { recursive: true })
    await cp(join(root, e.root), dir, {
      recursive: true,
      filter: (src) => !['node_modules', 'dist', '.git'].includes(src.split('/').at(-1))
    })
    const manifest = structuredClone(e.manifest)
    for (const key of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies'
    ])
      for (const sibling of entries)
        if (manifest[key]?.[sibling.manifest.name])
          manifest[key][sibling.manifest.name] = 'file:' + packed.get(sibling.root)
    // Pin transitive in-repo packages to their archives in this throwaway install only.
    for (const upstream of closure(e)) {
      const p = entries.find((x) => x.root === upstream)
      manifest.dependencies ??= {}
      manifest.dependencies[p.manifest.name] = 'file:' + packed.get(upstream)
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
    await seedLock(dir, manifest)
    await run(
      'npm',
      ['install', '--offline', '--no-audit', '--no-fund'],
      dir,
      'isolated-' + name + '-install'
    )
    await run('npm', ['run', 'build'], dir, 'isolated-' + name + '-build')
    r.source = 'build passed'
    await run(
      'npm',
      ['test', '--', '--reporter=json', '--outputFile=test-report.json'],
      dir,
      'isolated-' + name + '-test'
    )
    r.source = 'build and tests passed'
    const test = JSON.parse(await readFile(join(dir, 'test-report.json'), 'utf8'))
    r.tests = {
      total: test.numTotalTests,
      passed: test.numPassedTests,
      failed: test.numFailedTests,
      pending: test.numPendingTests
    }
    const consumer = join(attempt, 'consumer')
    await mkdir(consumer, { recursive: true })
    const dependencies = { [e.manifest.name]: 'file:' + packed.get(e.root) }
    for (const upstream of closure(e)) {
      const p = entries.find((x) => x.root === upstream)
      dependencies[p.manifest.name] = 'file:' + packed.get(upstream)
    }
    for (const [peer, version] of Object.entries(e.manifest.peerDependencies ?? {}))
      if (!dependencies[peer]) dependencies[peer] = version
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify(
        {
          private: true,
          type: 'module',
          dependencies,
          devDependencies: {
            typescript: e.manifest.devDependencies.typescript,
            '@types/node': e.manifest.devDependencies['@types/node'],
            ...(e.manifest.devDependencies['@types/react']
              ? { '@types/react': e.manifest.devDependencies['@types/react'] }
              : {})
          }
        },
        null,
        2
      )
    )
    await seedLock(consumer, JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')))
    await run(
      'npm',
      ['install', '--offline', '--omit=dev', '--no-audit', '--no-fund'],
      consumer,
      'consumer-' + name + '-production-install'
    )
    const specs = Object.keys(e.manifest.exports)
      .filter((k) => !k.endsWith('.css'))
      .map((k) => (k === '.' ? e.manifest.name : e.manifest.name + k.slice(1)))
    await writeFile(
      join(consumer, 'check.ts'),
      specs.map((s, i) => `import * as E${i} from '${s}'; void E${i};`).join('\n')
    )

    await writeFile(
      join(consumer, 'check.mjs'),
      `import assert from 'node:assert/strict';\nfor(const spec of ${JSON.stringify(specs)}) await import(spec);\nawait assert.rejects(import('${e.manifest.name}/src/index.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});\n`
    )
    await run(process.execPath, ['check.mjs'], consumer, 'consumer-' + name + '-runtime')
    if (name === 'pdf-translation') {
      await cp(join(root, e.root, 'test/packed-runtime.mjs'), join(consumer, 'packed-runtime.mjs'))
      await run(process.execPath, ['packed-runtime.mjs'], consumer, 'consumer-' + name + '-worker')
    }
    for (const [key, target] of Object.entries(e.manifest.exports).filter(([k]) =>
      k.endsWith('.css')
    )) {
      const asset = join(consumer, 'node_modules', e.manifest.name, target)
      if (!(await readFile(asset, 'utf8')).includes('@source'))
        throw Error('Missing stylesheet source entry ' + key)
    }
    const browserEntries =
      name === 'pdf-translation'
        ? ['contracts', 'text', 'reader'].map((entry) => e.manifest.name + '/' + entry)
        : name === 'pdf-structure'
          ? [e.manifest.name + '/result']
          : name === 'pdf-document-contract'
            ? specs
            : []
    if (browserEntries.length) {
      await writeFile(
        join(consumer, 'browser.ts'),
        browserEntries
          .map((s, i) => `import * as E${i} from '${s}'; console.log(E${i});`)
          .join('\n')
      )
      await run(
        join(root, 'node_modules/.bin/esbuild'),
        ['browser.ts', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.js'],
        consumer,
        'consumer-' + name + '-browser'
      )
    }
    await run(
      'npm',
      ['install', '--offline', '--include=dev', '--no-audit', '--no-fund'],
      consumer,
      'consumer-' + name + '-type-tools'
    )
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
        'check.ts'
      ],
      consumer,
      'consumer-' + name + '-types'
    )
    if ((await fingerprint(join(root, e.root))) !== inputHashes[e.root])
      throw Error('Package changed during isolation; rerun against a stable snapshot')
    r.consumer = 'exports, declarations, private paths passed'
    console.log('passed', name, r.tests)
  } catch (error) {
    r.error = String(error)
    console.log('FAILED', name, r.error)
  } finally {
    await writeFile(join(evidence, 'isolated-report.json'), JSON.stringify(report, null, 2))
  }
}
// Also validate cached records and upstream archives: a dependency edited while another
// package is being checked must invalidate that consumer's apparent success.
const finalHashes = Object.fromEntries(
  await Promise.all(entries.map(async (e) => [e.root, await fingerprint(join(root, e.root))]))
)
const finalLockHash = createHash('sha256')
  .update(await readFile(join(root, 'package-lock.json')))
  .digest('hex')
for (const record of report) {
  if (
    finalLockHash !== lockHash ||
    Object.keys(record.inputs?.packages ?? {}).some((p) => finalHashes[p] !== inputHashes[p])
  )
    record.error = 'Package inputs changed during isolation; rerun against a stable snapshot'
}
await writeFile(join(evidence, 'isolated-report.json'), JSON.stringify(report, null, 2))
console.log('Evidence:', fresh)
if (report.some((r) => r.error)) process.exitCode = 1
