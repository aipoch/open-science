import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import {
  localPackageLinks,
  packDependencies,
  packSnapshot,
  restoreDependencies,
  restoreSnapshot,
  validateIdentity
} from './e2e-setup-snapshot.mjs'

const roots: string[] = []
const environment = { ...process.env, GITHUB_RUN_ID: '1234' }

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ producer: string; consumer: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), 'e2e-snapshot-'))
  roots.push(root)
  const producer = join(root, 'producer')
  const consumer = join(root, 'consumer')
  const archive = join(root, 'archive')
  await mkdir(producer)
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: producer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  git(['init'])
  await writeFile(join(producer, 'package.json'), '{}')
  await writeFile(
    join(producer, 'package-lock.json'),
    JSON.stringify({
      packages: { 'node_modules/@local/native': { link: true, resolved: 'packages/native' } }
    })
  )
  git(['add', '.'])
  git(['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture'])
  git(['clone', '--no-hardlinks', producer, consumer])
  for (const [path, content] of Object.entries({
    'node_modules/.prisma/client/index.js': 'generated Prisma fixture',
    'node_modules/.bin/tool': '#!/bin/sh\nexit 0\n',
    'packages/native/build/Release/native.node': 'native fixture',
    'out/main/index.js': 'current build'
  })) {
    await mkdir(dirname(join(producer, path)), { recursive: true })
    await writeFile(join(producer, path), content)
  }
  await chmod(join(producer, 'node_modules/.bin/tool'), 0o755)
  const link = join(producer, 'node_modules/@local/native')
  const target = join(producer, 'packages/native')
  await mkdir(dirname(link), { recursive: true })
  await symlink(
    process.platform === 'win32' ? target : relative(dirname(link), target),
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  return { producer, consumer, archive }
}

describe('same-run E2E setup snapshots', () => {
  it('packs and restores dependencies without requiring a build output', async () => {
    const { producer, consumer, archive } = await fixture()
    await rm(join(producer, 'out'), { recursive: true })
    expect(await packDependencies(producer, archive, environment)).toBeGreaterThan(0)
    await restoreDependencies(consumer, archive, environment)
    expect(await readFile(join(consumer, 'node_modules/.prisma/client/index.js'), 'utf8')).toBe(
      'generated Prisma fixture'
    )
    expect(await realpath(join(consumer, 'node_modules/@local/native'))).toBe(
      await realpath(join(consumer, 'packages/native'))
    )
  })

  it('accepts a valid archive when tar finishes before consuming its trailing padding', async () => {
    const { producer, consumer, archive } = await fixture()
    await packSnapshot(producer, archive, environment)
    const archivePath = join(archive, 'setup.tar.gz')
    // Tar ends at zero records. A reader may exit successfully without consuming every padded byte.
    // Make the padding exceed pipe buffers so the producer cannot finish writing before tar exits.
    const padded = gzipSync(
      Buffer.concat([gunzipSync(await readFile(archivePath)), Buffer.alloc(4 * 1024 * 1024)])
    )
    await writeFile(archivePath, padded)
    const manifestPath = join(archive, 'setup.json')
    const metadata = JSON.parse(await readFile(manifestPath, 'utf8'))
    metadata.sha256 = createHash('sha256').update(padded).digest('hex')
    await writeFile(manifestPath, JSON.stringify(metadata))
    await restoreSnapshot(consumer, archive, environment)
    expect(await readFile(join(consumer, 'out/main/index.js'), 'utf8')).toBe('current build')
  })

  it('moves generated files and executable modes, rebasing local links to the consumer', async () => {
    const { producer, consumer, archive } = await fixture()
    expect(await packSnapshot(producer, archive, environment)).toBeGreaterThan(0)
    // Rerunning a consumer must not require the current attempt to equal the producer attempt.
    await restoreSnapshot(consumer, archive, { ...environment, GITHUB_RUN_ATTEMPT: '2' })
    expect(await readFile(join(consumer, 'node_modules/.prisma/client/index.js'), 'utf8')).toBe(
      'generated Prisma fixture'
    )
    expect(await readFile(join(consumer, 'out/main/index.js'), 'utf8')).toBe('current build')
    expect(await realpath(join(consumer, 'node_modules/@local/native'))).toBe(
      await realpath(join(consumer, 'packages/native'))
    )
    expect(
      await readFile(join(consumer, 'node_modules/@local/native/build/Release/native.node'), 'utf8')
    ).toBe('native fixture')
    expect((await lstat(join(producer, 'node_modules/@local/native'))).isSymbolicLink()).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(join(consumer, 'node_modules/.bin/tool'))).mode & 0o111).toBe(0o111)
    }
  })

  it('rejects a different run before extracting files', async () => {
    const { producer, consumer, archive } = await fixture()
    await packSnapshot(producer, archive, environment)
    await expect(
      restoreSnapshot(consumer, archive, { ...environment, GITHUB_RUN_ID: 'other' })
    ).rejects.toThrow('runId mismatch')
    await expect(lstat(join(consumer, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a corrupted archive before extracting files', async () => {
    const { producer, consumer, archive } = await fixture()
    await packSnapshot(producer, archive, environment)
    await writeFile(join(archive, 'setup.tar.gz'), 'corrupted')
    await expect(restoreSnapshot(consumer, archive, environment)).rejects.toThrow(
      'checksum mismatch'
    )
    await expect(lstat(join(consumer, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to restore through a pre-existing shared dependency junction', async () => {
    const { producer, consumer, archive } = await fixture()
    await packSnapshot(producer, archive, environment)
    await symlink(
      join(producer, 'node_modules'),
      join(consumer, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(restoreSnapshot(consumer, archive, environment)).rejects.toThrow(
      'absent node_modules'
    )
    expect(await readFile(join(producer, 'node_modules/.prisma/client/index.js'), 'utf8')).toBe(
      'generated Prisma fixture'
    )
  })

  it('does not publish a snapshot when required build output is absent', async () => {
    const { producer, archive } = await fixture()
    await rm(join(producer, 'out'), { recursive: true })
    await expect(packSnapshot(producer, archive, environment)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(lstat(join(archive, 'setup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['revision', 'platform', 'arch', 'node', 'lockHash'])(
    'rejects mismatched %s identity',
    (key) => {
      expect(() => validateIdentity({ [key]: 'old' }, { [key]: 'current' })).toThrow(
        `${key} mismatch`
      )
    }
  )

  it.each(['../unowned', 'packages/../unowned', '/absolute', 'C:\\unowned'])(
    'rejects unsupported local package target %s',
    (resolved) => {
      expect(() =>
        localPackageLinks({ packages: { 'node_modules/local': { link: true, resolved } } })
      ).toThrow('Unsupported local package link')
    }
  )
})
