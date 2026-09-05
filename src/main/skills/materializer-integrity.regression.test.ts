import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClaudeCodeSkillMaterializer } from './materializer'
import { UserSkillRepository } from './user-skill-repository'
import { catalogFingerprint } from './user-skill-catalog-observer'

// Scope failure injection to one filesystem call, with real I/O for everything else.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(fs.rm).mockReset()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.rm).mockImplementation(actual.rm)
  for (const root of roots.splice(0)) {
    // Runtime copies are read-only; restore only temporary test directories before cleanup.
    const writable = async (directory: string): Promise<void> => {
      await fs.chmod(directory, 0o755)
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await writable(path)
        else await fs.chmod(path, 0o644)
      }
    }
    await writable(root)
    await actual.rm(root, { recursive: true, force: true })
  }
})
const fixture = async (): Promise<{
  root: string
  repo: UserSkillRepository
  configDir: string
  materializer: ClaudeCodeSkillMaterializer
}> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-runtime-integrity-'))
  roots.push(root)
  const repo = new UserSkillRepository(root)
  await repo.createPersonal({ name: 'demo', description: 'Demo', body: 'Body' })
  return {
    root,
    repo,
    configDir: join(root, 'runtime'),
    materializer: new ClaudeCodeSkillMaterializer()
  }
}

describe('reported runtime Skill integrity regressions', () => {
  it('SK04 reports failed withdrawal, retains tracking and allows a later successful retry', async () => {
    const { repo, configDir, materializer } = await fixture()
    await materializer.sync(configDir, await repo.list(), { directoryLayout: 'app-owned' })
    const target = join(configDir, 'skills', 'os-personal-demo')
    const manifest = join(configDir, 'skills', '.os-versions.json')
    const before = await fs.readFile(manifest, 'utf8')
    expect(await fs.readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Body')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let blocked = true
    const busy = Object.assign(new Error('Injected target EBUSY'), { code: 'EBUSY' })
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (String(path) === target && blocked) throw busy
      return actual.rm(path, options)
    })
    const result = await materializer.sync(configDir, [], { directoryLayout: 'app-owned' }).then(
      () => 'success',
      () => 'failure'
    )
    expect.soft(result).toBe('failure')
    expect.soft(await fs.readFile(manifest, 'utf8')).toBe(before)
    expect(await fs.readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Body')
    blocked = false
    await materializer.sync(configDir, [], { directoryLayout: 'app-owned' })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await fs.readFile(manifest, 'utf8'))).toEqual({})
  })

  it.skipIf(process.platform === 'win32')(
    'SK05 propagates a chmod-only executable change into the existing runtime copy',
    async () => {
      const { root, repo, configDir, materializer } = await fixture()
      const scripts = join(root, 'skills', 'personal', 'demo', 'scripts')
      await fs.mkdir(scripts)
      const source = join(scripts, 'run.sh')
      await fs.writeFile(source, '#!/bin/sh\necho demo\n', { mode: 0o644 })
      const before = await repo.list()
      await materializer.sync(configDir, before)
      const target = join(configDir, 'skills', 'os-personal-demo', 'scripts', 'run.sh')
      expect((await fs.stat(target)).mode & 0o111).toBe(0)
      await fs.chmod(source, 0o755)
      expect((await fs.stat(source)).mode & 0o111).toBe(0o111)
      const after = await repo.list()
      expect(after[0].updatedAt).toBe(before[0].updatedAt)
      expect.soft(after[0].compatibility).not.toBe(before[0].compatibility)
      expect.soft(catalogFingerprint(after)).not.toBe(catalogFingerprint(before))
      await materializer.sync(configDir, after)
      expect((await fs.stat(target)).mode & 0o111).toBe(0o111)
    }
  )
})
