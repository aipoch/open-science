import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import { decodeRunDocumentDataPaths, encodeRunDocumentDataPaths } from './run-document-data-paths'

const ROOT = '/data/os'

const buildDocument = (): NotebookRunDocument => ({
  version: 1,
  projectName: 'default-project',
  sessionId: 'session-1',
  workspaceCwd: `${ROOT}/notebooks/default-project/session-1`,
  notebookSessionRoot: `${ROOT}/notebooks/default-project/session-1`,
  dataRoot: `${ROOT}/notebooks/default-project/session-1/data`,
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: `${ROOT}/runtime`,
    lastKnownStatus: 'idle'
  },
  runs: [
    {
      runId: 'run-1',
      cellId: 'cell-1',
      source: 'agent',
      script: "print('hello')",
      status: 'completed',
      startedAt: 100,
      endedAt: 200,
      cwdBefore: `${ROOT}/notebooks/default-project/session-1`,
      cwdAfter: `${ROOT}/notebooks/default-project/session-1`,
      text: { stdout: 'hello\n', stderr: '', traceback: '', plain: ['hello'] },
      outputs: [],
      artifacts: [
        {
          id: 'a1',
          projectName: 'default-project',
          sessionId: 'session-1',
          runId: 'run-1',
          name: 'plot.png',
          path: `${ROOT}/notebooks/default-project/session-1/data/processed/plot.png`,
          fileUrl: `file://${ROOT}/notebooks/default-project/session-1/data/processed/plot.png`,
          size: 10,
          mtimeMs: 0
        }
      ],
      workingFiles: [
        {
          path: `${ROOT}/notebooks/default-project/session-1/data/processed.csv`,
          relativePath: 'data/processed.csv',
          kind: 'processed-data',
          size: 123,
          mtimeMs: 200,
          createdByRunId: 'run-1'
        }
      ]
    }
  ],
  updatedAt: 0
})

describe('run document data-path codec', () => {
  it('encodes every data-root path field to a $DATA sentinel and drops artifact fileUrl', () => {
    const doc = buildDocument()
    const encoded = encodeRunDocumentDataPaths(doc, ROOT)

    expect(encoded.notebookSessionRoot).toBe('$DATA/notebooks/default-project/session-1')
    expect(encoded.dataRoot).toBe('$DATA/notebooks/default-project/session-1/data')
    expect(encoded.kernel.runtimeRoot).toBe('$DATA/runtime')
    expect(encoded.workspaceCwd).toBe('$DATA/notebooks/default-project/session-1')
    expect(encoded.runs[0].cwdBefore).toBe('$DATA/notebooks/default-project/session-1')
    expect(encoded.runs[0].cwdAfter).toBe('$DATA/notebooks/default-project/session-1')
    expect(encoded.runs[0].workingFiles[0].path).toBe(
      '$DATA/notebooks/default-project/session-1/data/processed.csv'
    )
    expect(encoded.runs[0].workingFiles[0].relativePath).toBe('data/processed.csv')
    expect(encoded.runs[0].artifacts[0].path).toBe(
      '$DATA/notebooks/default-project/session-1/data/processed/plot.png'
    )
    expect(encoded.runs[0].artifacts[0].fileUrl).toBeUndefined()

    // Unrelated fields are untouched.
    expect(encoded.runs[0].text.stdout).toBe('hello\n')
    expect(encoded.runs[0].script).toBe("print('hello')")
  })

  it('decodes a $DATA sentinel document against a new data root and recomputes fileUrl', () => {
    const doc = buildDocument()
    const encoded = encodeRunDocumentDataPaths(doc, ROOT)
    const decoded = decodeRunDocumentDataPaths(encoded, '/mnt/new')

    const at = (rel: string): string => join('/mnt/new', rel)
    expect(decoded.notebookSessionRoot).toBe(at('notebooks/default-project/session-1'))
    expect(decoded.dataRoot).toBe(at('notebooks/default-project/session-1/data'))
    expect(decoded.kernel.runtimeRoot).toBe(at('runtime'))
    expect(decoded.workspaceCwd).toBe(at('notebooks/default-project/session-1'))
    expect(decoded.runs[0].cwdBefore).toBe(at('notebooks/default-project/session-1'))
    expect(decoded.runs[0].cwdAfter).toBe(at('notebooks/default-project/session-1'))
    expect(decoded.runs[0].workingFiles[0].path).toBe(
      at('notebooks/default-project/session-1/data/processed.csv')
    )
    expect(decoded.runs[0].artifacts[0].path).toBe(
      at('notebooks/default-project/session-1/data/processed/plot.png')
    )
    expect(decoded.runs[0].artifacts[0].fileUrl).toMatch(/^file:\/\/.*plot\.png$/)
  })

  it('leaves an external workspaceCwd unchanged on encode', () => {
    const doc = { ...buildDocument(), workspaceCwd: '/Users/x/proj' }
    expect(encodeRunDocumentDataPaths(doc, ROOT).workspaceCwd).toBe('/Users/x/proj')
  })
})
