import { mkdtemp, mkdir, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveBundleDir } from './environment-resources'

const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-local-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveBundleDir', () => {
  it('returns an override only when it exists', async () => {
    const root = await makeRoot()
    expect(resolveBundleDir({ override: root })).toBe(root)
    expect(resolveBundleDir({ override: join(root, 'missing') })).toBeUndefined()
  })

  it('prefers app.asar.unpacked under resourcesPath', async () => {
    const root = await makeRoot()
    const unpacked = join(root, 'app.asar.unpacked', 'resources', 'default-envs')
    await mkdir(unpacked, { recursive: true })
    expect(resolveBundleDir({ resourcesPath: root })).toBe(unpacked)
  })
})
