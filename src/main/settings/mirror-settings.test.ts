import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { SettingsRepository, sanitizePackageMirror } = await import('./repository')

describe('sanitizePackageMirror', () => {
  it('keeps only string url/path fields and drops junk', () => {
    expect(
      sanitizePackageMirror({
        condaChannel: 'https://c',
        pypiIndex: 5,
        cranMirror: 'https://cran',
        caBundle: '/x.pem',
        extra: true
      })
    ).toEqual({ condaChannel: 'https://c', cranMirror: 'https://cran', caBundle: '/x.pem' })
  })

  it('returns undefined when nothing valid survives', () => {
    expect(sanitizePackageMirror({ pypiIndex: 9 })).toBeUndefined()
    expect(sanitizePackageMirror(null)).toBeUndefined()
  })
})

describe('SettingsRepository.setPackageMirror', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a configured mirror', async () => {
    const repo = new SettingsRepository(dir)
    await repo.setPackageMirror({ condaChannel: 'https://c', pypiIndex: 'https://p/simple' })
    const settings = await repo.getSettings()
    expect(settings.packageMirror).toEqual({
      condaChannel: 'https://c',
      pypiIndex: 'https://p/simple'
    })
  })

  it('clears the mirror back to public hosts when set empty', async () => {
    const repo = new SettingsRepository(dir)
    await repo.setPackageMirror({ condaChannel: 'https://c' })
    await repo.setPackageMirror({})
    const settings = await repo.getSettings()
    expect(settings.packageMirror).toBeUndefined()
  })

  it('survives a repository read (proves sanitizeSettings keeps it)', async () => {
    const repo = new SettingsRepository(dir)
    await repo.setPackageMirror({ cranMirror: 'https://cran.example/' })
    const reread = new SettingsRepository(dir)
    const settings = await reread.getSettings()
    expect(settings.packageMirror).toEqual({ cranMirror: 'https://cran.example/' })
  })
})
