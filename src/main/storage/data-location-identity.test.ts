import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { dataLocationIdentity } from './data-location-identity'

let fixture: string
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'data-location-identity-'))
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

const unavailableInodes = {
  stat: () => ({ dev: 0n, ino: 0n }),
  realpath: (path: string) => realpathSync.native(path)
}

it.each([undefined, unavailableInodes])(
  'keeps distinct real directories distinct with filesystem identity mode %j',
  async (dependencies) => {
    const first = join(fixture, 'first')
    const second = join(fixture, 'second')
    await mkdir(first)
    await mkdir(second)
    expect(dataLocationIdentity(first, dependencies)).not.toBe(
      dataLocationIdentity(second, dependencies)
    )
  }
)

it.each([undefined, unavailableInodes])(
  'recognizes aliases to the same real directory with filesystem identity mode %j',
  async (dependencies) => {
    const original = join(fixture, 'original')
    const alias = join(fixture, 'alias')
    await mkdir(original)
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(dataLocationIdentity(original, dependencies)).toBe(
      dataLocationIdentity(alias, dependencies)
    )
  }
)

it('does not conflate distinct case-sensitive directory identities', () => {
  // A filesystem contract test, not a claim that the host filesystem is case-sensitive.
  const dependencies = { stat: unavailableInodes.stat, realpath: (path: string) => path }
  expect(dataLocationIdentity('/research/OpenScience-DEV', dependencies)).not.toBe(
    dataLocationIdentity('/research/OpenScience-dev', dependencies)
  )
  expect(dataLocationIdentity('C:\\research\\OpenScience-DEV', dependencies)).not.toBe(
    dataLocationIdentity('C:\\research\\OpenScience-dev', dependencies)
  )
})

it('does not merge real Windows candidate paths based on matching file indexes', async () => {
  const first = join(fixture, 'first')
  const second = join(fixture, 'second')
  await mkdir(first)
  await mkdir(second)
  const dependencies = {
    ...unavailableInodes,
    platform: 'win32' as const,
    stat: () => ({ dev: 1n, ino: 123n })
  }
  expect(dataLocationIdentity(first, dependencies)).not.toBe(
    dataLocationIdentity(second, dependencies)
  )
})

it('respects the real host filesystem case sensitivity for historical dev folders', async () => {
  const upper = join(fixture, 'OpenScience-DEV')
  const lower = join(fixture, 'OpenScience-dev')
  await mkdir(upper)
  let sameDirectory = false
  try {
    await mkdir(lower)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    sameDirectory = true
  }
  if (!sameDirectory) {
    expect(dataLocationIdentity(upper)).not.toBe(dataLocationIdentity(lower))
  } else {
    expect(dataLocationIdentity(upper)).toBe(dataLocationIdentity(lower))
  }
})

it('preserves distinct POSIX inode identities above the safe integer range', () => {
  const dependencies = {
    platform: 'linux' as const,
    stat: (root: string) => ({
      dev: 1n,
      ino: root === 'first' ? 9007199254740992n : 9007199254740993n
    }),
    realpath: (root: string) => root
  }
  expect(dataLocationIdentity('first', dependencies)).not.toBe(
    dataLocationIdentity('second', dependencies)
  )
})
