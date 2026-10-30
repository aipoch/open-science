import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LocalModelSnapshot } from '../../shared/local-models'
import { createLocalOcrModelOwner } from './ocr-owner'
import type { LocalModelOwner, LocalModelUse } from './owner'

const snapshot = (overrides: Partial<LocalModelSnapshot> = {}): LocalModelSnapshot => ({
  availability: 'ready',
  recommendedRevision: 'v1',
  installedRevision: 'v1',
  downloadBytes: 0,
  installedBytes: 1,
  hasFiles: true,
  inUse: false,
  transferredBytes: 0,
  updateAvailable: false,
  ...overrides
})

const owner = (code: string): LocalModelOwner => {
  const asset = {
    file: `${code}.traineddata.gz`,
    path: `/models/${code}.traineddata.gz`,
    size: 1,
    sha256: 'a'.repeat(64)
  }
  const use: LocalModelUse = {
    revision: `${code}-v1`,
    assets: [asset],
    release: vi.fn()
  }
  return {
    acquireUse: vi.fn(async () => use),
    close: vi.fn(async () => undefined),
    getSnapshot: vi.fn(async () => snapshot()),
    install: vi.fn(async () => snapshot()),
    cancel: vi.fn(async () => snapshot()),
    remove: vi.fn(async () => snapshot())
  }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('installs and acquires only the selected OCR language packs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-ocr-owner-'))
  roots.push(root)
  const base = owner('runtime')
  const packs = Object.fromEntries(
    ['eng', 'chi_sim', 'deu'].map((code) => [code, owner(code)])
  ) as Parameters<typeof createLocalOcrModelOwner>[0]['languagePacks']
  const ocr = createLocalOcrModelOwner({
    base,
    languagePacks: packs,
    defaultLanguages: ['eng', 'deu'],
    dataRoot: () => root
  })

  await ocr.install()
  expect(base.install).toHaveBeenCalledOnce()
  expect(packs.eng).toBeDefined()
  expect(packs.deu).toBeDefined()
  expect(packs.chi_sim).toBeDefined()
  expect(packs.eng!.install).toHaveBeenCalledOnce()
  expect(packs.deu!.install).toHaveBeenCalledOnce()
  expect(packs.chi_sim!.install).not.toHaveBeenCalled()

  const use = await ocr.acquireUse()
  expect(use.languages).toEqual(['eng', 'deu'])
  expect(use.assets.map((asset) => asset.file)).toEqual([
    'runtime.traineddata.gz',
    'eng.traineddata.gz',
    'deu.traineddata.gz'
  ])

  expect(ocr.setOcrLanguages).toBeDefined()
  await ocr.setOcrLanguages!(['eng', 'chi_sim'])
  expect(
    JSON.parse(await readFile(join(root, 'models/ocr/languages.json'), 'utf8')).languages
  ).toEqual(['eng', 'chi_sim'])
})
