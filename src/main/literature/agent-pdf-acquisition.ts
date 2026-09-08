import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiteratureCandidateOrigin } from '../../shared/literature'
import type { LiteratureLibraryDiscovery } from './library-mcp-server'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'
import type { LiteratureFullTextFinder } from './full-text-finder'
import { downloadFullText, fullTextUrl } from './full-text-download'
import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'

type Request = {
  candidate: LiteratureLibraryDiscovery
  pdfUrl?: string
  signal?: AbortSignal
  origin: LiteratureCandidateOrigin
}
export type AgentPdfAcquisitionResult = {
  status: 'pending-review' | 'already-reviewed' | 'not-found'
  candidateId?: string
  filename?: string
  sourceUrl?: string
  notices?: string[]
}
type Options = {
  catalog: Pick<LiteratureCatalog, 'stageAcquiredPdf'>
  content: Pick<ContentRepository, 'publish'>
  fullText: Pick<LiteratureFullTextFinder, 'discover'>
  download: typeof downloadFullText
  pageCount?: typeof inspectPdfPageCount
}
export class AgentPdfAcquisition {
  constructor(private readonly options: Options) {}
  async acquire(request: Request): Promise<AgentPdfAcquisitionResult> {
    const { signal } = request
    signal?.throwIfAborted()
    const search = request.pdfUrl
      ? {
          candidates: [
            {
              url: fullTextUrl(request.pdfUrl).href,
              sourceUrl: request.candidate.source.sourceUrl,
              provider: request.candidate.source.provider,
              source: request.candidate.source.provider,
              version: undefined,
              license: undefined
            }
          ],
          notices: []
        }
      : await this.options.fullText.discover(request.candidate.item)
    signal?.throwIfAborted()
    if (!search.candidates.length) return { status: 'not-found', notices: search.notices }
    let failure: unknown
    for (const candidate of search.candidates.slice(0, 3)) {
      signal?.throwIfAborted()
      let directory: string | undefined
      let downloaded = false
      try {
        const bytes = await this.options.download(
          candidate.url,
          MAX_AUTO_EXTRACT_PDF_BYTES,
          undefined,
          undefined,
          signal
        )
        signal?.throwIfAborted()
        if (
          bytes.length > MAX_AUTO_EXTRACT_PDF_BYTES ||
          bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
        )
          throw new Error('The full-text link did not return a PDF.')
        directory = await mkdtemp(join(tmpdir(), 'open-science-inbox-pdf-'))
        const path = join(directory, 'paper.pdf')
        await writeFile(path, bytes, { mode: 0o600 })
        const pageCount = await (this.options.pageCount ?? inspectPdfPageCount)(path)
        signal?.throwIfAborted()
        downloaded = true
        const filename = `${
          request.candidate.item.title
            .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
            .trim()
            .slice(0, 120) || 'paper'
        }.pdf`
        let sourceUrl = new URL(candidate.url).origin
        if (candidate.sourceUrl) {
          try {
            sourceUrl = fullTextUrl(candidate.sourceUrl).href
          } catch {
            /* Use the public download host. */
          }
        }
        const provenance = {
          provider: candidate.provider,
          source: candidate.source,
          sourceUrl,
          acquiredAt: Date.now(),
          version: candidate.version,
          license: candidate.license
        }
        let receipt!: Awaited<ReturnType<Options['catalog']['stageAcquiredPdf']>>
        await this.options.content.publish({
          sourcePath: path,
          contentType: 'application/pdf',
          commit: async (content) => {
            signal?.throwIfAborted()
            receipt = await this.options.catalog.stageAcquiredPdf(
              {
                ...request.candidate,
                source: {
                  ...request.candidate.source,
                  rawMetadata: {
                    metadata: request.candidate.source.rawMetadata,
                    fullText: { ...provenance, downloadUrl: candidate.url }
                  }
                },
                origin: request.origin
              },
              {
                contentBlobId: content.id,
                filename,
                contentType: 'application/pdf',
                sizeBytes: Number(content.sizeBytes),
                checksum: content.checksum,
                pageCount,
                provenance,
                sourceUrl
              },
              signal
            )
          }
        })
        return {
          status: receipt.state === 'pending' ? 'pending-review' : 'already-reviewed',
          candidateId: receipt.id,
          filename,
          sourceUrl
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (downloaded) throw error
        failure = error
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
    throw failure ?? new Error('No full-text PDF could be acquired.')
  }
}
