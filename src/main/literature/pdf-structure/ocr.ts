import { createHash } from 'node:crypto'
import type { LocalModelOwner, LocalModelUse } from '../../local-models/owner'
import type { PdfStructureOcr } from '@aipoch/pdf-structure'

export type PdfStructureOcrUse = {
  options: PdfStructureOcr
  fingerprint: string
  release(): void
}

export const acquirePdfStructureOcr = async (
  models?: Pick<LocalModelOwner, 'getSnapshot' | 'acquireUse'>
): Promise<PdfStructureOcrUse | undefined> => {
  if (!models) return
  let use: LocalModelUse | undefined
  try {
    if ((await models.getSnapshot()).availability !== 'ready') return
    use = await models.acquireUse()
    const engine = use.assets.find((asset) => asset.file === 'ocr-engine.mjs')
    const languages = [...(use.languages ?? ['eng', 'chi_sim'])]
    const languageAssets: Record<string, string> = {}
    for (const code of languages) {
      const asset = use.assets.find((asset) => asset.file === `${code}.traineddata.gz`)
      if (asset) languageAssets[code] = asset.path
    }
    if (!engine || !languages.length || languages.some((code) => !languageAssets[code])) {
      use.release()
      return
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          revision: use.revision,
          languages,
          assets: use.assets
            .map(({ file, sha256 }) => ({ file, sha256 }))
            .sort((a, b) => a.file.localeCompare(b.file))
        })
      )
      .digest('hex')
    return {
      options: {
        enginePath: engine.path,
        languages,
        languageAssets
      },
      fingerprint,
      release: use.release
    }
  } catch {
    use?.release()
    // Optional recognition never installs models or prevents native extraction.
    return
  }
}

export const pdfStructureOcrFingerprint = (base: string, ocr?: PdfStructureOcrUse): string =>
  ocr ? createHash('sha256').update(base).update(ocr.fingerprint).digest('hex') : base
