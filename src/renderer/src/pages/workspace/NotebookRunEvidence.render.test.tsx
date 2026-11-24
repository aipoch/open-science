// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookRunEvidence } from './NotebookRunEvidence'

afterEach(cleanup)
it('shows the frozen interpreter and saved helper digest without inventing legacy evidence', () => {
  const run: NotebookRunRecord = {
    runId: 'old-run',
    cellId: 'cell',
    source: 'agent',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt: 0,
    outputs: [],
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    workingFiles: [],
    frozenRuntimeTarget: {
      language: 'python',
      environment: 'old-env',
      processKey: 'python:old-env',
      interpreterPath: '/old/bin/python'
    },
    helperModules: [
      {
        helperId: 'old-helper',
        skillIdentity: 'skill',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: '1',
        exports: [],
        source: 'old code',
        sourceDigest: 'old-digest'
      }
    ]
  }
  const { rerender } = render(<NotebookRunEvidence run={run} />)
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('/old/bin/python')
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('old-digest')
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain(
    'Environment evidence is incomplete or unavailable.'
  )
  rerender(<NotebookRunEvidence run={run} showEnvironmentCaptureWarning={false} />)
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('old-run')
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('/old/bin/python')
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('old-digest')
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain(
    'Environment evidence is incomplete or unavailable.'
  )
  rerender(
    <NotebookRunEvidence
      run={{ ...run, frozenRuntimeTarget: undefined, helperModules: undefined }}
    />
  )
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain('/old/bin/python')
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain('old-digest')
})

it('loads the package manifest only after the evidence disclosure opens', async () => {
  const run: NotebookRunRecord = {
    runId: 'lazy-run',
    cellId: 'cell',
    source: 'agent',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt: 0,
    outputs: [],
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    workingFiles: [],
    environment: 'default',
    environmentCapture: { state: 'available', manifestChecksum: 'manifest-checksum' },
    environmentManifestChecksum: 'manifest-checksum'
  }
  const loadRun = vi.fn().mockResolvedValue({
    ...run,
    environmentManifest: {
      schemaVersion: 1,
      captureKind: 'completed-run',
      capturedAt: '2026-01-01T00:00:00.000Z',
      installedInventory: {
        capturedAt: '2026-01-01T00:00:00.000Z',
        source: 'full-scan',
        validation: 'full-scan'
      },
      kernelKind: 'python',
      environmentName: 'default',
      runtimeSource: 'managed',
      inventorySources: ['kernel-native'],
      packages: [
        {
          name: 'numpy',
          version: '1.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-kernel-modules']
        }
      ],
      complete: true,
      captureStatus: 'complete'
    }
  })

  render(<NotebookRunEvidence run={run} loadRun={loadRun} />)
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain('numpy')

  fireEvent.click(screen.getByText('Execution evidence'))
  await waitFor(() => expect(screen.getByText('numpy · 1.0')).toBeTruthy())
  expect(loadRun).toHaveBeenCalledWith('lazy-run')
})

it('uses the capture checksum fallback and reports an unavailable sidecar', async () => {
  const run: NotebookRunRecord = {
    runId: 'legacy-run',
    cellId: 'cell',
    source: 'agent',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt: 0,
    outputs: [],
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    workingFiles: [],
    environment: 'default',
    environmentCapture: { state: 'available', manifestChecksum: 'legacy-checksum' }
  }
  const loadRun = vi.fn().mockResolvedValue(run)

  render(<NotebookRunEvidence run={run} loadRun={loadRun} />)
  expect(screen.getByTestId('notebook-run-evidence').textContent).toContain('legacy-checksum')

  fireEvent.click(screen.getByText('Execution evidence'))
  await waitFor(() =>
    expect(screen.getByTestId('notebook-run-evidence').textContent).toContain(
      'Environment evidence is incomplete or unavailable.'
    )
  )
  expect(loadRun).toHaveBeenCalledWith('legacy-run')
})
