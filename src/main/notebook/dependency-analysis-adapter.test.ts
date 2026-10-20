import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'

it('does not derive a managed interpreter from an unsafe persisted environment', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'analysis-adapter-'))
  try {
    const analyze = vi.fn()
    const analyzer = createNotebookDependencyAnalyzer({
      storageRoot,
      repository: {
        readSessionRuns: async () => [
          {
            runId: 'run-1',
            cellId: 'cell-1',
            kernelKind: 'python',
            status: 'completed',
            kernelEpochId: 'epoch-1',
            script: 'x = 1',
            environment: '../../project-controlled',
            workingFiles: []
          }
        ]
      },
      analyze
    })
    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'unknown', reasons: ['parser-unavailable'] } }
    })
    expect(analyze).not.toHaveBeenCalled()
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()
