import { Worker } from 'node:worker_threads'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  lstat,
  rename,
  chmod,
  link,
  readdir
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  publishNoReplace,
  recoverAnchoredRemoval,
  removeAnchoredFile,
  removeAnchoredTree
} from './atomic-no-replace-publisher'

const require = createRequire(import.meta.url)
const nativeBindingAvailable = (() => {
  try {
    require('@aipoch/safe-file-publisher-native')
    return true
  } catch {
    return false
  }
})()

let cleanupRoot: string | undefined

afterEach(async () => {
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true })
  cleanupRoot = undefined
})

describe.skipIf(!nativeBindingAvailable)('atomic no-replace publisher', () => {
  it('reports publication capabilities for a local storage root', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('@aipoch/safe-file-publisher-native') as {
      inspectPath: (path: string) => { isRemote: boolean; supportsHardLinks: boolean }
    }

    expect(binding.inspectPath(cleanupRoot)).toEqual({
      isRemote: false,
      supportsHardLinks: true
    })
  })

  it('publishes within an anchored parent without replacing an existing destination', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const sourcePath = join(cleanupRoot, 'source.tmp')
    const destinationPath = join(cleanupRoot, 'content')
    await writeFile(sourcePath, 'verified')

    publishNoReplace(cleanupRoot, cleanupRoot, basename(sourcePath), basename(destinationPath))

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(sourcePath, 'next')
    expect(() =>
      publishNoReplace(cleanupRoot!, cleanupRoot!, basename(sourcePath), basename(destinationPath))
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('next')
  })

  it('rejects a symlinked or junction publication parent', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideParent = join(cleanupRoot, 'outside')
    const linkedParent = join(cleanupRoot, 'linked')
    await mkdir(outsideParent)
    await writeFile(join(outsideParent, 'source.tmp'), 'verified')
    await symlink(outsideParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => publishNoReplace(cleanupRoot!, linkedParent, 'source.tmp', 'content')).toThrow()
    await expect(readFile(join(outsideParent, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

// These exercise the real native mutation boundary on each portable CI platform.
describe.skipIf(!nativeBindingAvailable)('anchored publication removal', () => {
  it('removes only the named file and rejects a changed parent identity', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
    const parent = join(cleanupRoot, 'content')
    await mkdir(parent)
    const identity = await lstat(parent, { bigint: true })
    await writeFile(join(parent, 'attempt.tmp'), 'interrupted')
    await writeFile(join(parent, 'published'), 'keep')
    const file = await lstat(join(parent, 'attempt.tmp'), { bigint: true })
    removeAnchoredFile(cleanupRoot, 'content', 'attempt.tmp', identity, file)
    await expect(readFile(join(parent, 'attempt.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(parent, 'published'), 'utf8')).toBe('keep')
    await rename(parent, `${parent}-held`)
    await mkdir(parent)
    await writeFile(join(parent, 'attempt.tmp'), 'replacement')
    expect(() =>
      removeAnchoredFile(cleanupRoot!, 'content', 'attempt.tmp', identity, file)
    ).toThrow(expect.objectContaining({ code: 'ESTALE' }))
    expect(await readFile(join(parent, 'attempt.tmp'), 'utf8')).toBe('replacement')
  })

  it.skipIf(process.platform === 'win32')(
    'binds native content receipts to their authority and rejects publication recovery',
    async () => {
      cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-content-removal-'))
      const parent = await lstat(cleanupRoot, { bigint: true })
      const path = join(cleanupRoot, 'legacy.pdf')
      await writeFile(path, 'original')
      const file = await lstat(path, { bigint: true })
      await writeFile(path, 'replacement bytes')
      const recoveryName = `.content-recovery-${'a'.repeat(64)}`
      expect(() =>
        removeAnchoredFile(cleanupRoot!, '', 'legacy.pdf', parent, file, recoveryName)
      ).toThrow(expect.objectContaining({ code: 'ESTALE' }))
      expect(await readFile(join(cleanupRoot, recoveryName, 'receipt'), 'utf8')).toBe(
        [
          'content-removal-v1',
          recoveryName,
          'legacy.pdf',
          parent.dev,
          parent.ino,
          file.dev,
          file.ino,
          file.size,
          file.mtimeNs,
          ''
        ].join('\n')
      )
      expect(() => recoverAnchoredRemoval(cleanupRoot!, '', recoveryName, parent)).toThrow(
        expect.objectContaining({ code: 'EINVAL' })
      )
      expect(() =>
        recoverAnchoredRemoval(cleanupRoot!, '', recoveryName, parent, 'another.pdf')
      ).toThrow(expect.objectContaining({ code: 'EINVAL' }))
      expect(() =>
        recoverAnchoredRemoval(cleanupRoot!, '', recoveryName, parent, 'legacy.pdf')
      ).toThrow(expect.objectContaining({ code: 'ESTALE' }))
      expect(await readFile(path, 'utf8')).toBe('replacement bytes')
    }
  )

  it.each(['root', 'ancestor', 'parent'] as const)(
    'refuses a linked %s directory',
    async (level) => {
      cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
      const root = join(cleanupRoot, 'root')
      const parent = join(root, 'content', 'blobs')
      await mkdir(parent, { recursive: true })
      await writeFile(join(parent, 'attempt.tmp'), 'keep')
      const identity = await lstat(parent, { bigint: true })
      const target = level === 'root' ? root : level === 'ancestor' ? join(root, 'content') : parent
      await rename(target, `${target}-held`)
      await symlink(`${target}-held`, target, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() =>
        removeAnchoredFile(root, join('content', 'blobs'), 'attempt.tmp', identity, identity)
      ).toThrow()
      expect(await readFile(join(parent, 'attempt.tmp'), 'utf8')).toBe('keep')
    }
  )

  it('rejects traversal and directory leaves without removing their contents', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
    const identity = await lstat(cleanupRoot, { bigint: true })
    await mkdir(join(cleanupRoot, 'nested'))
    await writeFile(join(cleanupRoot, 'nested', 'keep'), 'keep')
    expect(() => removeAnchoredFile(cleanupRoot!, '..', 'anything', identity, identity)).toThrow()
    expect(() => removeAnchoredFile(cleanupRoot!, '', '../anything', identity, identity)).toThrow()
    expect(() => removeAnchoredFile(cleanupRoot!, '', 'nested', identity, identity)).toThrow()
    expect(await readFile(join(cleanupRoot, 'nested', 'keep'), 'utf8')).toBe('keep')
  })
})

// Exercise the real addon in a child with only renameat2 denied. No production test hook is needed.
describe.skipIf(process.platform !== 'linux' || !nativeBindingAvailable)(
  'publication removal without renameat2',
  () => {
    it.each(['ENOSYS', 'EOPNOTSUPP', 'EINVAL'])(
      'removes and recovers interrupted files when renameat2 returns %s',
      async (errorCode) => {
        cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-fallback-'))
        const launcherSource = join(cleanupRoot, 'restrict-rename.c')
        const launcher = join(cleanupRoot, 'restrict-rename')
        await writeFile(
          launcherSource,
          `
#include <errno.h>
#include <stddef.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc, char **argv) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_renameat2, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ${errorCode}),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { sizeof(filter) / sizeof(filter[0]), filter };
  if (argc < 2 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  execvp(argv[1], &argv[1]);
  return 126;
}
`
        )
        execFileSync('cc', [launcherSource, '-o', launcher])
        const exercise = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const binding = require(process.argv[1]);
const root = process.argv[2];
const relative = 'content/blobs/aa';
const parentPath = path.join(root, relative);
fs.mkdirSync(parentPath, { recursive: true });
const name = 'a'.repeat(64) + '.01234567-89ab-4def-8123-456789abcdef.tmp';
const source = path.join(parentPath, name);
const quarantineName = '.publication-recovery-01234567-89ab-4def-8123-456789abcdef';
const quarantine = path.join(parentPath, quarantineName);
const parent = fs.lstatSync(parentPath, { bigint: true });
fs.writeFileSync(source, 'interrupted');
let file = fs.lstatSync(source, { bigint: true });
binding.removeAnchoredFile(root, relative, name, parent.dev, parent.ino,
  file.dev, file.ino, file.size, file.mtimeNs, quarantineName);
assert.deepEqual(fs.readdirSync(parentPath), []);
// Recover both an old receipt awaiting capture and a captured replacement.
for (const replaced of [false, true]) {
  fs.writeFileSync(source, 'original');
  file = fs.lstatSync(source, { bigint: true });
  fs.mkdirSync(quarantine, { mode: 0o700 });
  fs.writeFileSync(path.join(quarantine, 'receipt'), [
    'publication-removal-v1', name, parent.dev, parent.ino,
    file.dev, file.ino, file.size, file.mtimeNs, ''
  ].join('\\n'), { mode: 0o600 });
  if (replaced) {
    fs.renameSync(source, source + '-held');
    fs.writeFileSync(path.join(quarantine, 'payload'), 'replacement');
  }
  const recover = () => binding.recoverAnchoredRemoval(root, relative, quarantineName,
    parent.dev, parent.ino);
  if (replaced) {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(recover, { code: 'ESTALE' });
      assert.equal(fs.readFileSync(source, 'utf8'), 'replacement');
      assert.equal(fs.readFileSync(source + '-held', 'utf8'), 'original');
      assert.equal(fs.existsSync(path.join(quarantine, 'payload')), false);
      assert.equal(fs.existsSync(path.join(quarantine, 'receipt')), true);
    }
  } else {
    recover();
    assert.deepEqual(fs.readdirSync(parentPath), []);
  }
}
`
        execFileSync(
          launcher,
          [
            process.execPath,
            '-e',
            exercise,
            require.resolve('@aipoch/safe-file-publisher-native'),
            cleanupRoot
          ],
          { encoding: 'utf8' }
        )
      }
    )
  }
)

// Exercise the actual native boundary, including adversarial writers in another OS thread.
describe.skipIf(!nativeBindingAvailable)('anchored runtime tree removal', () => {
  it('removes read-only copies and links without changing external contents or hard-link permissions', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'runtime-tree-'))
    const target = join(cleanupRoot, 'attempt')
    const nested = join(target, 'skills', 'os-example')
    const external = join(cleanupRoot, 'external')
    await mkdir(nested, { recursive: true })
    await mkdir(external, { mode: 0o700 })
    await writeFile(join(external, 'private'), 'external content', { mode: 0o400 })
    const identity = await lstat(target, { bigint: true })
    const outside = await lstat(join(external, 'private'))
    await writeFile(join(nested, '.catalog_stamp'), 'readonly copy', { mode: 0o444 })
    await link(join(external, 'private'), join(nested, 'hard-link'))
    await symlink(
      external,
      join(nested, 'directory-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    if (process.platform !== 'win32') {
      await symlink(join(external, 'private'), join(nested, 'file-link'), 'file')
    }
    await chmod(nested, 0o555)
    await chmod(target, 0o555)
    removeAnchoredTree(cleanupRoot, 'attempt', identity)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(external, 'private'), 'utf8')).toBe('external content')
    expect((await lstat(join(external, 'private'))).mode).toBe(outside.mode)
    expect(await readdir(external)).toEqual(['private'])
    // Cleanup is idempotent after deletion.
    removeAnchoredTree(cleanupRoot, 'attempt', identity)
  })

  it.each(['identity', 'ancestor', 'root'] as const)('refuses a changed %s', async (change) => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'runtime-tree-identity-'))
    const storage = join(cleanupRoot, 'storage')
    const parent = join(storage, 'runtime')
    const target = join(parent, 'attempt')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'keep'), 'must survive')
    const identity = await lstat(target, { bigint: true })
    if (change === 'identity') {
      await rename(target, `${target}-old`)
      await mkdir(target)
      await writeFile(join(target, 'keep'), 'replacement')
    } else {
      const swapped = change === 'root' ? storage : parent
      await rename(swapped, `${swapped}-old`)
      await symlink(`${swapped}-old`, swapped, process.platform === 'win32' ? 'junction' : 'dir')
    }
    expect(() => removeAnchoredTree(storage, join('runtime', 'attempt'), identity)).toThrow()
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe(
      change === 'identity' ? 'replacement' : 'must survive'
    )
    expect(() => removeAnchoredTree(storage, '../outside', identity)).toThrow()
  })

  it('does not escape the held tree while another thread swaps a directory for a link', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'runtime-tree-race-'))
    const target = join(cleanupRoot, 'attempt')
    const external = join(cleanupRoot, 'external')
    await mkdir(join(target, 'race'), { recursive: true })
    await mkdir(external, { mode: 0o700 })
    await writeFile(join(external, 'private'), 'must survive', { mode: 0o600 })
    const identity = await lstat(target, { bigint: true })
    const externalMode = (await lstat(external)).mode
    const fileMode = (await lstat(join(external, 'private'))).mode
    // Keep traversal active while the worker repeatedly replaces the directory entry.
    for (let index = 0; index < 200; index++) {
      await mkdir(join(target, `copy-${index}`))
      await writeFile(join(target, `copy-${index}`, '.catalog_stamp'), 'copy')
    }
    const signal = new SharedArrayBuffer(8)
    const control = new Int32Array(signal)
    const worker = new Worker(
      `
      const { workerData, parentPort } = require('node:worker_threads')
      const fs = require('node:fs')
      const path = require('node:path')
      const control = new Int32Array(workerData.signal)
      const race = path.join(workerData.target, 'race')
      const held = path.join(workerData.target, 'held')
      parentPort.postMessage('ready')
      while (!Atomics.load(control, 0)) {
        try {
          fs.renameSync(race, held)
          fs.symlinkSync(workerData.external, race, process.platform === 'win32' ? 'junction' : 'dir')
          Atomics.add(control, 1, 1)
          fs.unlinkSync(race)
          fs.renameSync(held, race)
        } catch {}
      }
    `,
      { eval: true, workerData: { signal, target, external } }
    )
    const exited = new Promise<void>((resolve, reject) => {
      worker.once('exit', () => resolve())
      worker.once('error', reject)
    })
    try {
      await vi.waitFor(() => expect(Atomics.load(control, 1)).toBeGreaterThan(0))
      // Contention may fail closed; successful deletion is not required while a writer is live.
      try {
        removeAnchoredTree(cleanupRoot, 'attempt', identity)
      } catch (error) {
        expect(error).toHaveProperty('code')
      }
    } finally {
      Atomics.store(control, 0, 1)
      await exited
    }
    expect(await readFile(join(external, 'private'), 'utf8')).toBe('must survive')
    expect((await lstat(external)).mode).toBe(externalMode)
    expect((await lstat(join(external, 'private'))).mode).toBe(fileMode)
    expect(await readdir(external)).toEqual(['private'])
  })
})
