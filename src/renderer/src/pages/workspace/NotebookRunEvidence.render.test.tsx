// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

it('explains unfrozen Project inputs and opens the existing scoped upload flow', () => {
  const scope = { projectId: 'project-a', sessionId: 'session-a' }
  const requested = vi.fn()
  window.addEventListener('open-science:open-input-upload', requested)
  try {
    const run: NotebookRunRecord = {
      runId: 'project-run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: 'python',
      script: '',
      status: 'completed',
      startedAt: 0,
      outputs: [],
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      workingFiles: [],
      projectFolderInputs: [{ relativePath: 'raw.csv', sizeBytes: 8, frozen: false }]
    }
    const { rerender } = render(<NotebookRunEvidence run={run} uploadScope={scope} />)
    expect(screen.getByTestId('project-folder-input-evidence').textContent).toContain(
      'Inputs from the project folder are not frozen'
    )
    fireEvent.click(screen.getByText('Add key inputs as uploads'))
    expect(requested).toHaveBeenCalledOnce()
    expect((requested.mock.calls[0][0] as CustomEvent).detail).toEqual(scope)
    rerender(
      <NotebookRunEvidence run={{ ...run, projectFolderInputs: undefined }} uploadScope={scope} />
    )
    expect(screen.queryByTestId('project-folder-input-evidence')).toBeNull()
  } finally {
    window.removeEventListener('open-science:open-input-upload', requested)
  }
})
