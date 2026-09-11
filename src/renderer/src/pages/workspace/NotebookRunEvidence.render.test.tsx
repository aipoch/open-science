// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
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
  rerender(
    <NotebookRunEvidence
      run={{ ...run, frozenRuntimeTarget: undefined, helperModules: undefined }}
    />
  )
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain('/old/bin/python')
  expect(screen.getByTestId('notebook-run-evidence').textContent).not.toContain('old-digest')
})
