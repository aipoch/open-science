import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { UserSkillCompatibilityIndex } from './user-skill-compatibility-index'

const hashFileContents = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

describe('UserSkillCompatibilityIndex', () => {
  it('reuses persisted file hashes when an unchanged package is scanned after restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'large-skill')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: large-skill\ndescription: Large.\n---\nUse the asset.\n'
    )
    await writeFile(join(sourceDir, 'asset.bin'), Buffer.alloc(1024 * 1024, 7))

    const firstHash = vi.fn(hashFileContents)
    const [first] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: firstHash
    }).scan([sourceDir])

    expect(first).toMatchObject({ sourceDir })
    expect('compatibility' in first).toBe(true)
    expect(firstHash).toHaveBeenCalledTimes(2)
    const persisted = await readFile(
      join(storageRoot, 'runtime-support', 'user-skill-compatibility-v1.json'),
      'utf8'
    )
    expect(persisted).toContain('personal/large-skill')
    expect(persisted).not.toContain(storageRoot)

    const restartedHash = vi.fn(hashFileContents)
    const [restarted] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: restartedHash
    }).scan([sourceDir])

    expect(restarted).toEqual(first)
    expect(restartedHash).not.toHaveBeenCalled()
  })

  it('rebuilds a structurally corrupt cache instead of blocking the package scan', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-corrupt-'))
    const sourceDir = join(storageRoot, 'skills', 'imported', 'recoverable')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: recoverable\n---\nBody\n')
    const cachePath = join(storageRoot, 'runtime-support', 'user-skill-compatibility-v1.json')
    await mkdir(join(storageRoot, 'runtime-support'), { recursive: true })
    await writeFile(cachePath, '{"version":1,"packages":null}')

    const hashFile = vi.fn(hashFileContents)
    const [result] = await new UserSkillCompatibilityIndex(storageRoot, { hashFile }).scan([
      sourceDir
    ])

    expect(result).toMatchObject({ sourceDir })
    expect('compatibility' in result).toBe(true)
    expect(hashFile).toHaveBeenCalledOnce()
  })

  it('rehashes a cached file whose persisted SHA-256 is malformed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-hash-corrupt-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'corrupt-hash')
    const cachePath = join(storageRoot, 'runtime-support', 'user-skill-compatibility-v1.json')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: corrupt-hash\n---\nBody\n')
    await new UserSkillCompatibilityIndex(storageRoot, { hashFile: hashFileContents }).scan([
      sourceDir
    ])

    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
      packages: Record<string, { files: Record<string, { sha256: string }> }>
    }
    cache.packages['personal/corrupt-hash'].files['SKILL.md'].sha256 = 'not-a-sha256'
    await writeFile(cachePath, JSON.stringify(cache))

    const hashFile = vi.fn(hashFileContents)
    await new UserSkillCompatibilityIndex(storageRoot, { hashFile }).scan([sourceDir])

    expect(hashFile).toHaveBeenCalledOnce()
  })

  it('rehashes only changed content when its modification time is restored', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-changed-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'changed-skill')
    const assetPath = join(sourceDir, 'asset.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: changed-skill\n---\nBody\n')
    await writeFile(assetPath, Buffer.alloc(1024, 3))

    const [before] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: hashFileContents
    }).scan([sourceDir])
    const originalTimes = await stat(assetPath)
    await writeFile(assetPath, Buffer.alloc(1024, 4))
    await utimes(assetPath, originalTimes.atime, originalTimes.mtime)

    const changedHash = vi.fn(hashFileContents)
    const [after] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: changedHash
    }).scan([sourceDir])

    expect(changedHash).toHaveBeenCalledOnce()
    expect(changedHash).toHaveBeenCalledWith(assetPath)
    expect(after).not.toEqual(before)
  })

  it('keeps the loaded compatibility cache in memory across repeated catalog reads', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-memory-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'repeated')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: repeated\n---\nBody\n')

    const hashFile = vi.fn(hashFileContents)
    const index = new UserSkillCompatibilityIndex(storageRoot, { hashFile })
    await index.scan([sourceDir])
    await writeFile(
      join(storageRoot, 'runtime-support', 'user-skill-compatibility-v1.json'),
      'corrupt after load'
    )

    await index.scan([sourceDir])

    expect(hashFile).toHaveBeenCalledOnce()
  })

  it('changes compatibility for deleted files and prunes omitted packages', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-prune-'))
    const sourceDir = join(storageRoot, 'skills', 'imported', 'pruned')
    const assetPath = join(sourceDir, 'asset.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: pruned\n---\nBody\n')
    await writeFile(assetPath, 'asset')

    const hashFile = vi.fn(hashFileContents)
    const index = new UserSkillCompatibilityIndex(storageRoot, { hashFile })
    const [withAsset] = await index.scan([sourceDir])
    await rm(assetPath)
    const [withoutAsset] = await index.scan([sourceDir])

    expect(withoutAsset).not.toEqual(withAsset)
    expect(hashFile).toHaveBeenCalledTimes(2)

    await index.scan([])
    await index.scan([sourceDir])
    expect(hashFile).toHaveBeenCalledTimes(3)
  })

  it('includes prototype-like file names in package compatibility', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-prototype-'))
    const sourceDir = join(storageRoot, 'skills', 'imported', 'prototype-file')
    const prototypePath = join(sourceDir, '__proto__')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: prototype-file\n---\nBody\n')
    await writeFile(prototypePath, 'before')

    const index = new UserSkillCompatibilityIndex(storageRoot, { hashFile: hashFileContents })
    const [before] = await index.scan([sourceDir])
    await writeFile(prototypePath, 'after!')
    const [after] = await index.scan([sourceDir])

    expect(after).not.toEqual(before)
  })

  it('uses the production streaming hasher for large files', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-stream-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'streamed')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: streamed\n---\nBody\n')
    await writeFile(join(sourceDir, 'asset.bin'), Buffer.alloc(8 * 1024 * 1024, 9))

    const [result] = await new UserSkillCompatibilityIndex(storageRoot).scan([sourceDir])

    expect(result).toMatchObject({
      sourceDir,
      compatibility: expect.stringMatching(/^sha256-tree-v2:[a-f0-9]{64}$/)
    })
  })

  it('retries a file that changes while its contents are being hashed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'user-skill-index-race-'))
    const sourceDir = join(storageRoot, 'skills', 'personal', 'changing')
    const assetPath = join(sourceDir, 'asset.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: changing\n---\nBody\n')
    await writeFile(assetPath, 'before')

    let changed = false
    const mutatingHash = vi.fn(async (path: string): Promise<string> => {
      const bytes = await readFile(path)
      if (path === assetPath && !changed) {
        changed = true
        await writeFile(path, 'after!!')
      }
      return createHash('sha256').update(bytes).digest('hex')
    })
    const [duringWrite] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: mutatingHash
    }).scan([sourceDir])

    const restartedHash = vi.fn(hashFileContents)
    const [afterRestart] = await new UserSkillCompatibilityIndex(storageRoot, {
      hashFile: restartedHash
    }).scan([sourceDir])

    expect(duringWrite).toEqual(afterRestart)
    expect(mutatingHash).toHaveBeenCalledTimes(3)
    expect(restartedHash).not.toHaveBeenCalled()
  })
})
