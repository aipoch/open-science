import { describe, expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { reportNotebookEvidence, reportNotebookFileAnalysis } from './evidence-diagnostics'

const run: NotebookRunRecord = {
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'r',
  script: 'secret-patient-code',
  status: 'completed',
  startedAt: 1,
  executionCount: 1,
  cwdBefore: '/private/patient',
  text: { stdout: 'secret-result', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  environmentLock: {
    state: 'partial',
    format: 'environment-lock-bundle',
    lockChecksum: 'secret-checksum',
    partialReasons: ['non-conda-package-detected'],
    diagnostics: [
      {
        reason: 'package-lock-missing',
        packageName: 'private-package',
        observedVersion: 'private-version'
      },
      { reason: 'package-lock-missing', packageName: 'other-private-package' }
    ]
  }
}

describe('evidence support diagnostics', () => {
  it('reports lock reasons without code, paths, package identities, or content', () => {
    const info = vi.fn()
    reportNotebookEvidence(run, { info })
    expect(info).toHaveBeenCalledWith(
      'run evidence prepared',
      expect.objectContaining({
        notebookRunId: 'run-1',
        language: 'r',
        status: 'completed',
        lockState: 'partial',
        lockReasons: ['non-conda-package-detected'],
        lockDiagnosticReasons: ['package-lock-missing']
      })
    )
    const serialized = JSON.stringify(info.mock.calls)
    for (const secret of [
      'secret-patient-code',
      '/private/patient',
      'secret-result',
      'private-package',
      'private-version',
      'secret-checksum'
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('distinguishes missing evidence from a partial lock', () => {
    const info = vi.fn()
    reportNotebookEvidence(
      {
        ...run,
        environmentLock: { state: 'unavailable', reason: 'environment-lock-publication-failed' }
      },
      { info }
    )
    expect(info).toHaveBeenCalledWith(
      'run evidence prepared',
      expect.objectContaining({
        fileEvidenceState: 'unavailable',
        lockState: 'unavailable',
        lockReasons: ['environment-lock-publication-failed']
      })
    )
  })

  it('summarizes file analysis without retaining its paths or repeated reasons', () => {
    const info = vi.fn()
    reportNotebookFileAnalysis(
      'run-2',
      'python',
      {
        reads: ['private-input.csv'],
        writes: ['private-output.csv'],
        readState: 'partial',
        writeState: 'complete',
        externalState: 'partial',
        reasonCodes: Array.from({ length: 1000 }, () => 'dynamic-path-unresolved')
      },
      true,
      { info }
    )
    expect(info).toHaveBeenCalledWith('source file analysis prepared', {
      notebookRunId: 'run-2',
      language: 'python',
      hasPriorContext: true,
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      readCount: 1,
      writeCount: 1,
      writeScopeCount: 0,
      reasons: ['dynamic-path-unresolved']
    })
    expect(JSON.stringify(info.mock.calls)).not.toContain('private-')
  })

  it('cannot interrupt execution when the diagnostic sink throws', () => {
    expect(() =>
      reportNotebookEvidence(run, {
        info: () => {
          throw new Error('sink failed')
        }
      })
    ).not.toThrow()
    expect(() =>
      reportNotebookFileAnalysis(
        'run-2',
        'r',
        {
          reads: [],
          writes: [],
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reasonCodes: []
        },
        false,
        {
          info: () => {
            throw new Error('sink failed')
          }
        }
      )
    ).not.toThrow()
  })
})
