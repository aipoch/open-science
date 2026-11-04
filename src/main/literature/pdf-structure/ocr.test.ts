import { expect, it, vi } from 'vitest'
import { acquirePdfStructureOcr, pdfStructureOcrFingerprint } from './ocr'
import type { LocalModelOwner, LocalModelUse } from '../../local-models/owner'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve inferred fixture types.
const setup = (ready = true) => {
  const use = {
    revision: 'ocr-runtime-v1:eng',
    languages: ['eng'],
    assets: [
      { file: 'ocr-engine.mjs', path: '/models/ocr-engine.mjs', sha256: 'engine-sha', size: 1 },
      {
        file: 'eng.traineddata.gz',
        path: '/languages/eng.traineddata.gz',
        sha256: 'language-sha',
        size: 1
      }
    ],
    release: vi.fn()
  } satisfies LocalModelUse
  const models: Pick<LocalModelOwner, 'getSnapshot' | 'acquireUse'> = {
    getSnapshot: vi.fn(async () => ({
      availability: ready ? ('ready' as const) : ('notInstalled' as const),
      recommendedRevision: 'v1',
      downloadBytes: 0,
      installedBytes: 0,
      transferredBytes: 0,
      hasFiles: ready,
      inUse: false,
      updateAvailable: false
    })),
    acquireUse: vi.fn(async () => use)
  }
  return { use, models }
}
it('uses only installed assets and separates OCR cache identities by model content', async () => {
  const { use, models } = setup()
  const first = await acquirePdfStructureOcr(models)
  expect(first?.options.languageAssets).toEqual({ eng: '/languages/eng.traineddata.gz' })
  expect(pdfStructureOcrFingerprint('base', first)).not.toBe('base')
  use.assets[1].sha256 = 'changed-language'
  const second = await acquirePdfStructureOcr(models)
  expect(first?.fingerprint).not.toBe(second?.fingerprint)
  first?.release()
  second?.release()
  expect(use.release).toHaveBeenCalledTimes(2)
})
it('does not acquire an absent OCR model and preserves the native cache key', async () => {
  const { models } = setup(false)
  expect(await acquirePdfStructureOcr(models)).toBeUndefined()
  expect(models.acquireUse).not.toHaveBeenCalled()
  expect(pdfStructureOcrFingerprint('base')).toBe('base')
})
it('releases incomplete OCR assets and falls back after acquisition failure', async () => {
  const { use, models } = setup()
  use.assets.splice(0, 1)
  expect(await acquirePdfStructureOcr(models)).toBeUndefined()
  expect(use.release).toHaveBeenCalledOnce()
  vi.mocked(models.acquireUse).mockRejectedValueOnce(new Error('installation changed'))
  expect(await acquirePdfStructureOcr(models)).toBeUndefined()
})
