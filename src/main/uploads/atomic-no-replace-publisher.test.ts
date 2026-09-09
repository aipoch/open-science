import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishNoReplace, removeAnchoredFile } from './atomic-no-replace-publisher'

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
