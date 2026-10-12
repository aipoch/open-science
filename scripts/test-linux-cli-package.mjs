/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run as an ordinary user on a disposable native Linux runner with passwordless sudo.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { digest, packageRoot } from './linux-cli-packages.mjs'

assert.equal(process.platform, 'linux')
assert.notEqual(process.getuid(), 0, 'Exercise the runtime as an ordinary user')
const [format, argument] = process.argv.slice(2)
assert.ok(['deb', 'rpm'].includes(format))
const file = resolve(argument)
const temporary = await mkdtemp(join(tmpdir(), 'linux-cli-package-'))
const invoke = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options
  })
const sudo = (command, args) => invoke('sudo', ['-n', command, ...args])
const manager = format === 'deb' ? 'update-alternatives' : 'alternatives'
const install = () =>
  format === 'deb' ? sudo('apt-get', ['install', '-y', file]) : sudo('dnf', ['install', '-y', file])
const reinstall = () =>
  format === 'deb' ? sudo('dpkg', ['-i', file]) : sudo('rpm', ['-U', '--replacepkgs', file])
const remove = () =>
  format === 'deb'
    ? sudo('dpkg', ['--purge', 'open-science-cli'])
    : sudo('rpm', ['-e', 'open-science-cli'])
const alternative = (args) => sudo(manager, args)
let sleeper
let installed = false
try {
  // Preserve an unrelated user command; refusing installation must happen before overwrite.
  const unmanaged = '/usr/bin/open-science'
  sudo('sh', ['-c', `printf 'unowned-fixture\n' > ${unmanaged}`])
  assert.throws(install)
  assert.equal(await readFile(unmanaged, 'utf8'), 'unowned-fixture\n')
  sudo('rm', [unmanaged])
  install()
  installed = true
  assert.equal(await realpath('/usr/bin/open-science'), `${packageRoot}/open-science`)
  assert.equal(await realpath('/usr/bin/open-science-cli'), `${packageRoot}/open-science`)
  const source = JSON.parse(await readFile(`${packageRoot}/release.json`, 'utf8'))
  const node = `${packageRoot}/node-runtime/node`
  assert.equal(
    invoke(node, ['-p', 'process.versions.electron || process.versions.node']).trim(),
    source.nodeVersion
  )
  assert.match(invoke('open-science-cli', ['--help']), /open-science/)
  // Repackaging must preserve every file, including signed helpers and native binaries.
  const { readdir, lstat, readlink } = await import('node:fs/promises')
  const prepared = resolve(process.env.OPEN_SCIENCE_PACKAGE_PAYLOAD)
  const verifyFiles = async (path = '') => {
    for (const entry of await readdir(join(prepared, path))) {
      const relative = join(path, entry)
      const before = await lstat(join(prepared, relative))
      const after = await lstat(join(packageRoot, relative))
      assert.equal(before.isDirectory(), after.isDirectory())
      assert.equal(before.isSymbolicLink(), after.isSymbolicLink())
      if (before.isDirectory()) await verifyFiles(relative)
      else if (before.isSymbolicLink())
        assert.equal(
          await readlink(join(prepared, relative)),
          await readlink(join(packageRoot, relative))
        )
      else
        assert.equal(
          await digest(join(prepared, relative)),
          await digest(join(packageRoot, relative)),
          `Payload changed: ${relative}`
        )
    }
  }
  await verifyFiles()
  console.log('PASS installed payload matches original archive bytes')
  const sentinel = join(temporary, 'research-data')
  await writeFile(sentinel, 'preserve research data')
  // A real process executing this package's private Node must block replacement and removal.
  sleeper = spawn(node, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await once(sleeper.stdout, 'data')
  assert.throws(reinstall)
  assert.throws(remove)
  assert.match(invoke('open-science-cli', ['--help']), /open-science/)
  sleeper.kill()
  await once(sleeper, 'exit')
  sleeper = undefined
  reinstall()
  console.log('PASS running package blocks replacement/removal; stopped reinstall succeeds')
  // Exercise the existing full installed-backend fixture using the package's actual entry point.
  const env = {
    ...process.env,
    DISPLAY: '',
    WAYLAND_DISPLAY: '',
    PATH: `${packageRoot}/node-runtime:${process.env.PATH}`,
    OPEN_SCIENCE_TEST_PACKAGE: `${packageRoot}/backend`
  }
  // Fail with the actual fixture import error rather than a later agent-detection assertion.
  assert.match(
    invoke(node, [env.OPEN_SCIENCE_TEST_FAKE_AGENT, '--version'], { env }),
    /\d+\.\d+\.\d+/
  )
  console.log(invoke(node, [join(import.meta.dirname, 'test-backend-installed.mjs')], { env }))
  // A desktop candidate has priority 100; our candidate must preserve its automatic/manual choice.
  const desktop = join(temporary, 'desktop-cli')
  await writeFile(desktop, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  alternative(['--install', '/usr/bin/open-science', 'open-science', desktop, '100'])
  assert.equal(await realpath('/usr/bin/open-science'), desktop)
  alternative(['--set', 'open-science', desktop])
  reinstall()
  assert.equal(await realpath('/usr/bin/open-science'), desktop)
  remove()
  installed = false
  assert.equal(await realpath('/usr/bin/open-science'), desktop)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve research data')
  // Debian purge is retryable; RPM absence is explicitly verified rather than bypassed.
  if (format === 'deb') remove()
  else assert.throws(() => sudo('rpm', ['-q', 'open-science-cli']))
  alternative(['--remove', 'open-science', desktop])
  console.log('PASS alternatives coexistence, stopped uninstall and research data preservation')
} finally {
  if (sleeper) {
    sleeper.kill()
    await once(sleeper, 'exit')
  }
  if (installed) remove()
  await rm(temporary, { recursive: true, force: true })
}
