import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PdfStructureIdentity } from './result.js'

/** A runtime owns only the child it creates. stop must confirm termination before resolving. */
export type PdfStructureProcessRuntime = {
  spawn(entry: string): ChildProcessWithoutNullStreams
  stop(child: ChildProcessWithoutNullStreams): Promise<void>
}
export type PdfStructureEngineOptions = {
  /** Full, immutable recipe: all fields participate in the cache fingerprint. */
  modelRecipe: Readonly<{ revision: string }>
  runtime?: PdfStructureProcessRuntime
}
export type PdfStructureEngine = {
  describe(): Promise<{ fingerprint: string; modelRevision: string }>
  /** inputPath must be a disposable snapshot in its own job directory, never the original PDF. */
  start(request: {
    inputPath: string
    model: Readonly<{
      revision: string
      assets: readonly Readonly<{ file: string; path: string; size: number; sha256: string }>[]
    }>
    identity: PdfStructureIdentity
    signal: AbortSignal
    onProgress: (progress: { phase: string; processedPages: number[] }) => void
  }): {
    result: Promise<unknown>
    thumbnails: ReadonlyMap<string, Uint8Array>
    /** Joins conversion before cleanup. Retry rejection before releasing files or model leases. */
    stop(): Promise<void>
  }
}
