/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Native fixtures use Node's CommonJS runner. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: pause } = require('node:timers/promises')
const native = require('..')

const mac = { skip: process.platform !== 'darwin', timeout: 20000 }
test(
  'Darwin exec into another installation revokes the previously sampled executable authority',
  mac,
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-exec-identity-'))
    let child
    try {
      const source = path.join(directory, 'exec.c')
      const original = path.join(directory, 'original')
      const otherRoot = path.join(directory, 'Other.app', 'Contents', 'MacOS')
      fs.mkdirSync(otherRoot, { recursive: true })
      const replacement = path.join(otherRoot, 'worker')
      fs.writeFileSync(
        source,
        `#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  puts("ready"); fflush(stdout);
  if (argc == 2) { getchar(); execl(argv[1], argv[1], (char *)0); return 2; }
  for (;;) pause();
}`
      )
      execFileSync('/usr/bin/clang', [source, '-o', original], { timeout: 10000 })
      fs.copyFileSync(original, replacement)
      child = spawn(original, [replacement], { stdio: ['pipe', 'pipe', 'pipe'] })
      await once(child.stdout, 'data')
      const before = native.getDarwinProcess(child.pid)
      const oldPath = native.getDarwinProcessExecutable(child.pid, before.uniqueId)
      child.stdin.write('\n')
      const expected = fs.realpathSync(replacement)
      let changed = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (native.getDarwinProcessExecutable(child.pid, before.uniqueId) === expected) {
          changed = true
          break
        }
        await pause(10)
      }
      assert.equal(changed, true)
      assert.equal(native.getDarwinProcess(child.pid).uniqueId, before.uniqueId)
      assert.equal(native.signalDarwinProcess(child.pid, before.uniqueId, 9, oldPath), false)
      assert.equal(native.getDarwinProcessExecutable(child.pid, before.uniqueId), expected)
      const exited = once(child, 'exit')
      assert.equal(native.signalDarwinProcess(child.pid, before.uniqueId, 9, expected), true)
      await exited
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('Darwin generation-bound executable and signal reject stale identity', mac, async () => {
  const child = spawn('/bin/sleep', ['30'])
  try {
    await once(child, 'spawn')
    const identity = native.getDarwinProcess(child.pid)
    assert.ok(identity)
    assert.equal(native.getDarwinProcessExecutable(child.pid, identity.uniqueId), '/bin/sleep')
    assert.equal(native.getDarwinProcessExecutable(child.pid, '1'), null)
    assert.equal(native.signalDarwinProcess(child.pid, '1', 9, '/bin/sleep'), false)
    assert.equal(
      native.signalDarwinProcess(child.pid, identity.uniqueId, 9, '/different-installation/sleep'),
      false
    )
    assert.equal(native.getDarwinProcess(child.pid).uniqueId, identity.uniqueId)
    const exited = once(child, 'exit')
    assert.equal(native.signalDarwinProcess(child.pid, identity.uniqueId, 15, '/bin/sleep'), true)
    assert.deepEqual(await exited, [null, 'SIGTERM'])
    assert.equal(native.signalDarwinProcess(child.pid, identity.uniqueId, 9, '/bin/sleep'), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test(
  'independent Darwin scan finds real mappings and excludes ordinary descriptors and sibling bundles',
  mac,
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-installation-mappings-'))
    const children = []
    try {
      const root = path.join(directory, 'Science.app')
      const sibling = root + '-other'
      fs.mkdirSync(root)
      fs.mkdirSync(sibling)
      const source = path.join(directory, 'mapper.c')
      const binary = path.join(directory, 'mapper')
      fs.writeFileSync(
        source,
        `#include <sys/mman.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) return 2;
  if (argv[2][0] == 'm' && mmap(0, 4096, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED) return 3;
  puts("ready"); fflush(stdout);
  for (;;) pause();
}`
      )
      execFileSync('/usr/bin/clang', [source, '-o', binary], { timeout: 10000 })
      const start = async (file, mode) => {
        fs.writeFileSync(file, Buffer.alloc(4096, 1))
        const child = spawn(binary, [file, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
        children.push(child)
        await Promise.race([
          once(child.stdout, 'data'),
          once(child, 'exit').then(() => {
            throw new Error('Mapper exited before ready')
          })
        ])
        return child
      }
      const mapped = await start(path.join(root, 'mapped.bin'), 'map')
      const ordinary = await start(path.join(root, 'open.bin'), 'fd')
      const other = await start(path.join(sibling, 'mapped.bin'), 'map')
      const result = native.listDarwinInstallationMappings(fs.realpathSync(root))
      // Protected processes in another account may make whole-machine absence unprovable.
      // Known mapping evidence remains accurate, and incomplete coverage is explicitly unknown.
      assert.equal(typeof result.complete, 'boolean')
      assert.ok(result.pids.includes(mapped.pid))
      assert.ok(!result.pids.includes(ordinary.pid))
      assert.ok(!result.pids.includes(other.pid))
    } finally {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)
