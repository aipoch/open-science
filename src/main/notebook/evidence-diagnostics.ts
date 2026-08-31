import type { NotebookRunRecord } from '../../shared/notebook'
import type { ExecutionFileEvidenceReason } from '../../shared/execution-file-evidence'
import { createLogger, type Logger } from '../logger'
import type { NotebookSourceFileAccessAnalysis } from './dependency-analysis-types'

const log = createLogger('notebook:evidence')
const distinctReasons = (reasons: readonly string[] | undefined): string[] =>
  [...new Set(reasons)].slice(0, 32)

// Emit only bounded evidence vocabulary and counts. Never serialize a run, manifest,
// parser context, package diagnostic, or file reference into the support log.
const reportNotebookEvidence = (
  run: NotebookRunRecord,
  logger: Pick<Logger, 'info'> = log
): void => {
  try {
    const evidence = run.fileEvidence
    const capture = run.environmentCapture
    const lock = run.environmentLock
    const manifest = run.environmentManifest
    logger.info('run evidence prepared', {
      notebookRunId: run.runId,
      language: run.kernelKind,
      status: run.status,
      kernelDispatched: run.kernelDispatched,
      inputCount: run.inputFiles?.length ?? 0,
      workingFileCount: run.workingFiles?.length ?? 0,
      fileEvidenceState: evidence?.state ?? 'unavailable',
      fileReads: evidence?.fileReads,
      externalPaths: evidence?.externalPaths,
      writerAttribution: evidence?.writerAttribution,
      initialViewState: evidence?.initialViewState,
      managedRootsFinalState: evidence?.managedRootsFinalState,
      scientificOutputAnalysis: evidence?.scientificOutputAnalysis,
      relationCount: evidence?.relationCount,
      generationCount: evidence?.generationCount,
      scientificOutputCount: evidence?.scientificOutputCount,
      fileReasons: distinctReasons(evidence?.reasonCodes),
      environmentState: capture?.state ?? 'unavailable',
      environmentReason: capture?.state === 'unavailable' ? capture.reason : undefined,
      lockState: lock?.state ?? 'unavailable',
      lockReasons: distinctReasons(
        lock?.state === 'unavailable' ? [lock.reason] : lock?.partialReasons
      ),
      lockDiagnosticReasons: distinctReasons(
        lock?.state !== 'unavailable' ? lock?.diagnostics?.map(({ reason }) => reason) : undefined
      ),
      packageCount: manifest?.packages.length,
      inventorySource: manifest?.installedInventory.source,
      inventoryValidation: manifest?.installedInventory.validation,
      runtimeSource: manifest?.runtimeSource
    })
  } catch {
    // Feedback diagnostics cannot change execution or persistence outcomes.
  }
}

const reportNotebookFileAnalysis = (
  notebookRunId: string | undefined,
  language: NotebookRunRecord['kernelKind'],
  analysis: Omit<NotebookSourceFileAccessAnalysis, 'reasonCodes'> & {
    reasonCodes: readonly ExecutionFileEvidenceReason[]
  },
  hasPriorContext: boolean,
  logger: Pick<Logger, 'info'> = log
): void => {
  try {
    logger.info('source file analysis prepared', {
      notebookRunId,
      language,
      hasPriorContext,
      readState: analysis.readState,
      writeState: analysis.writeState,
      externalState: analysis.externalState,
      readCount: analysis.reads.length,
      writeCount: analysis.writes.length,
      writeScopeCount: analysis.writeScopes?.length ?? 0,
      reasons: distinctReasons(analysis.reasonCodes)
    })
  } catch {
    // Keep diagnostics outside the capture contract.
  }
}

export { reportNotebookEvidence, reportNotebookFileAnalysis }
