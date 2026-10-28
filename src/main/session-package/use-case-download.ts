import { resilientDownload } from '@aipoch/resilient-download'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUseCases, USE_CASE_MANIFEST_URL } from '../../shared/use-cases'

// Resolve the slug independently of renderer metadata and verify bytes before archive inspection.
export const downloadUseCase = async (
  slug: string,
  signal: AbortSignal,
  progress: (bytes: number, total: number) => void
): Promise<{ path: string; release: () => Promise<void> }> => {
  const manifest = await fetch(USE_CASE_MANIFEST_URL, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: 'error'
  })
  if (!manifest.ok) throw new Error('Could not load use cases.')
  const item = parseUseCases(await manifest.json()).find((item) => item.slug === slug)
  if (!item) throw new Error('Use case is unavailable.')
  const directory = await mkdtemp(join(tmpdir(), 'open-science-use-case-'))
  const release = (): Promise<void> => rm(directory, { recursive: true, force: true })
  // A slug is a portable filename, including on Windows where published titles can contain colons.
  const path = join(directory, `case-${slug}.science`)
  try {
    await resilientDownload(item.packageUrl, path, {
      signal,
      expectedSize: item.sizeBytes,
      expectedSha256: item.sha256,
      maxRetries: 0,
      fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' }),
      onProgress: ({ transferred }) => progress(transferred, item.sizeBytes)
    })
    signal.throwIfAborted()
    return { path, release }
  } catch (error) {
    await release()
    throw error
  }
}
