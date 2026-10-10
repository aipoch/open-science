/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Serve the actual packed bytes locally so npm, not the fixture, selects/installs the native package.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyRuntimeSignatures } from './verify-runtime-signatures.mjs'
import { currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(process.argv[2] ?? join(root, 'out/npm-artifacts'))
const { packages } = JSON.parse(
  await readFile(join(directory, `${currentRuntimeTarget().id}.json`), 'utf8')
)
const prefix = await mkdtemp(join(tmpdir(), 'open-science-npm-install-'))
const exec = promisify(execFile)
const npm = (...args) =>
  exec(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: prefix,
    env: { ...process.env, DISPLAY: '', ELECTRON_RUN_AS_NODE: '' },
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024
  })
const bytes = new Map()
for (const pkg of packages) {
  const tarball = await readFile(join(directory, pkg.filename))
  assert.equal(`sha512-${createHash('sha512').update(tarball).digest('base64')}`, pkg.integrity)
  bytes.set(pkg.filename, tarball)
}
let registry
const downloaded = new Set()
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1)
  if (bytes.has(path)) {
    downloaded.add(path)
    res.end(bytes.get(path))
    return
  }
  const pkg = packages.find((item) => item.manifest.name === path)
  if (!pkg) {
    res.writeHead(404)
    res.end('{"error":"not_found"}')
    return
  }
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      name: path,
      'dist-tags': { latest: pkg.manifest.version },
      versions: {
        [pkg.manifest.version]: {
          ...pkg.manifest,
          dist: { tarball: `${registry}/${pkg.filename}`, integrity: pkg.integrity }
        }
      }
    })
  )
})
try {
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  registry = `http://127.0.0.1:${server.address().port}`
  const main = packages.find((item) => item.manifest.name === '@aipoch/open-science')
  await npm(
    'install',
    '--prefix',
    prefix,
    '--registry',
    registry,
    '--cache',
    join(prefix, 'cache'),
    '--no-audit',
    '--no-fund',
    '--include=optional',
    `${main.manifest.name}@${main.manifest.version}`
  )
  for (const pkg of packages)
    assert.ok(downloaded.has(pkg.filename), `npm must download ${pkg.filename}`)
  const installed = join(prefix, 'node_modules/@aipoch/open-science')
  if (process.env.OPEN_SCIENCE_RUNTIME_VERIFY_SIGNATURES === '1')
    await verifyRuntimeSignatures(
      join(prefix, 'node_modules', `@aipoch/open-science-${currentRuntimeTarget().id}`)
    )
  const probe = join(prefix, 'verify.mjs')
  await writeFile(
    probe,
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { locateBackend } from './node_modules/@aipoch/open-science/locate-backend.mjs';
const backend = await locateBackend();
assert.equal(backend.development, false);
assert.ok(!process.versions.electron);
const require = createRequire(backend.entry);
for (const name of ['@aipoch/process-tree-native', '@aipoch/safe-file-publisher-native', '@prisma/client']) require(name);
for (const executable of Object.values(require('@aipoch/credential-identity-probe-native'))) await import('node:fs/promises').then(fs => fs.access(executable));
console.log('Native dependencies load in ordinary Node');
`
  )
  console.log((await exec(process.execPath, [probe], { cwd: prefix })).stdout.trim())
  const help = await npm('exec', '--prefix', prefix, '--offline', '--', 'open-science', '--help')
  assert.match(help.stdout, /open-science/)
  const checkNoElectron = async (path) => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      assert.ok(
        !/^(@electron|electron$|electron-builder$)/.test(item.name),
        `Electron in installed closure: ${item.name}`
      )
      await checkNoElectron(join(path, item.name))
    }
  }
  await checkNoElectron(join(prefix, 'node_modules'))
  if (process.platform === 'linux' && process.env.OPEN_SCIENCE_NPM_LIVE_TEST === '1') {
    const env = {
      ...process.env,
      DISPLAY: '',
      PATH: `${join(prefix, 'node_modules/.bin')}:${process.env.PATH}`,
      OPEN_SCIENCE_TEST_PACKAGE: installed,
      OPEN_SCIENCE_TEST_FAKE_AGENT: join(root, 'e2e/fixtures/fake-opencode.mjs'),
      OPEN_SCIENCE_WEB_PORT: '0'
    }
    const result = await exec(
      process.execPath,
      [join(root, 'scripts/test-backend-installed.mjs')],
      { cwd: prefix, env, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 }
    )
    console.log(result.stdout)
  }
  console.log('PASS real npm resolution, npx entry, native loading and Electron-free install')
} finally {
  await new Promise((done) => server.close(done))
  await rm(prefix, { recursive: true, force: true })
}
