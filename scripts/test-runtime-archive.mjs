/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'
import { archiveFilename, archiveStem, archiveTar, sha256 } from './runtime-archives.mjs'
import { verifyRuntimeSignatures } from './verify-runtime-signatures.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(process.argv[2] ?? join(root, 'out/cli-artifacts'))
const target = currentRuntimeTarget()
const report = JSON.parse(await readFile(join(directory, `${target.id}.json`), 'utf8'))
assert.equal(report.filename, archiveFilename(report.version, target))
assert.equal(await sha256(join(directory, report.filename)), report.sha256)
const temporary = await mkdtemp(join(tmpdir(), 'open-science archive install '))
const exec = promisify(execFile)
try {
  await exec(archiveTar, ['-xf', join(directory, report.filename), '-C', temporary], {
    timeout: 180_000
  })
  const installed = join(temporary, archiveStem(report.version, target))
  const nodeDirectory = join(installed, 'node-runtime')
  const node = join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node')
  const backend = join(installed, 'backend')
  const probe = join(installed, 'verify.mjs')
  await writeFile(
    probe,
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { locateBackend } from './backend/locate-backend.mjs';
assert.ok(!process.versions.electron);
assert.equal(process.versions.node, ${JSON.stringify(report.nodeVersion)});
const backend = await locateBackend();
assert.equal(backend.development, false);
assert.equal(backend.command, process.execPath);
const require = createRequire(backend.entry);
for (const name of ['@aipoch/process-tree-native', '@aipoch/safe-file-publisher-native', '@prisma/client']) require(name);
for (const path of Object.values(require('@aipoch/credential-identity-probe-native'))) await access(path);
console.log('PASS bundled Node and native dependencies');
`
  )
  console.log((await exec(node, [probe], { cwd: temporary })).stdout.trim())
  await rm(probe)
  const forbidden = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      assert.ok(
        !/^(@electron|electron$|electron-builder$)/.test(entry.name),
        `Electron in archive: ${entry.name}`
      )
      await forbidden(join(path, entry.name))
    }
  }
  await forbidden(backend)
  if (process.env.OPEN_SCIENCE_RUNTIME_VERIFY_SIGNATURES === '1')
    await verifyRuntimeSignatures(installed)
  // A host tool accidentally used by the launcher must fail, even on provisioned CI runners.
  const poison = join(temporary, 'host tools')
  await mkdir(poison)
  for (const name of ['node', 'npm', 'npx', 'electron']) {
    const path = join(poison, name + (process.platform === 'win32' ? '.cmd' : ''))
    await writeFile(path, process.platform === 'win32' ? '@exit /b 91\r\n' : '#!/bin/sh\nexit 91\n')
    await chmod(path, 0o755)
  }
  const env = {
    ...process.env,
    DISPLAY: '',
    PATH: `${poison}${delimiter}${process.env.PATH}`,
    OPEN_SCIENCE_CONFIG_ROOT: join(temporary, 'profile'),
    OPEN_SCIENCE_WEB_PORT: '0'
  }
  const launcher = join(
    installed,
    process.platform === 'win32' ? 'open-science.cmd' : 'open-science'
  )
  const cli = async (args) => {
    if (process.platform === 'win32')
      return exec(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`],
        // The command string already uses cmd.exe quoting, not the C runtime argv convention.
        { cwd: temporary, env, timeout: 60_000, windowsVerbatimArguments: true }
      )
    return exec(launcher, args, { cwd: temporary, env, timeout: 60_000 })
  }
  assert.match((await cli(['--help'])).stdout, /open-science/)
  try {
    await cli(['status', '--json'])
    assert.fail('Stopped runtime status must exit with code 1')
  } catch (error) {
    assert.equal(error.code, 1)
    assert.deepEqual(JSON.parse(error.stdout), { running: false })
    assert.equal(error.stderr, '')
  }
  console.log('PASS extracted CLI from path with spaces without host Node/npm/Electron')
  if (process.platform === 'linux' && process.env.OPEN_SCIENCE_ARCHIVE_LIVE_TEST === '1') {
    const result = await exec(node, [join(root, 'scripts/test-backend-installed.mjs')], {
      cwd: temporary,
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...env,
        PATH: `${installed}${delimiter}${nodeDirectory}${delimiter}${env.PATH}`,
        OPEN_SCIENCE_TEST_PACKAGE: backend,
        OPEN_SCIENCE_TEST_FAKE_AGENT: join(root, 'e2e/fixtures/fake-opencode.mjs')
      }
    })
    console.log(result.stdout)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
