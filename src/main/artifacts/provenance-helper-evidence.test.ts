import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type { NotebookHelperModuleEvidence, NotebookRunRecord } from '../../shared/notebook'
import {
  buildBoundedExecutionSnapshot,
  parseArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { projectPublicArtifactExecutionSnapshot } from './provenance-read-model'

const digest = (source: string): string => createHash('sha256').update(source).digest('hex')

const helper = (
  helperId: string,
  source = `def ${helperId.replaceAll('-', '_')}():\n    return ${JSON.stringify(helperId)}`,
  registeredGeneration = 'generation-1'
): NotebookHelperModuleEvidence => ({
  helperId,
  skillIdentity: `skill:${helperId}`,
  packageOrigin: 'built-in',
  interfaceRevision: '1',
  registeredGeneration,
  exports: [helperId.replaceAll('-', '_')],
  source,
  sourceDigest: digest(source)
})

const run = (
  runId: string,
  script: string,
  helpers: NotebookHelperModuleEvidence[]
): NotebookRunRecord => ({
  runId,
  kernelEpochId: 'epoch-1',
  kernelDispatched: true,
  helperModules: helpers,
  helperEvidenceStatus: { state: 'complete' },
  cellId: runId,
  source: 'agent',
  kernelKind: 'python',
  script,
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: []
})

const snapshot = (runs: NotebookRunRecord[]): PersistedArtifactExecutionSnapshot =>
  buildBoundedExecutionSnapshot(
    {
      schemaVersion: 2,
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: runs.at(-1)!.runId,
      producerRunIndex: runs.length - 1,
      createdAt: '2026-08-26T00:00:00.000Z'
    },
    runs.map((value, runIndex) => ({ run: value, runIndex }))
  )

describe('Artifact helper execution evidence', () => {
  it('freezes and deterministically deduplicates sticky helper generations', () => {
    const first = helper('helper-a')
    const value = snapshot([
      run('run-1', 'seed = helper_a()', [first]),
      run('run-2', 'write(seed)', [first, helper('helper-b')])
    ])
    first.source = 'def helper_a():\n    return "replacement"'

    expect(value.helperEvidenceStatus).toEqual({ state: 'complete' })
    expect(value.helperModules?.map(({ helperId }) => helperId)).toEqual(['helper-a', 'helper-b'])
    expect(value.helperModules?.[0]?.source).toContain('return "helper-a"')
    expect(value.runs.map(({ helperModuleKeys }) => helperModuleKeys?.length)).toEqual([1, 2])
  })

  it('marks corrupt or over-capacity required helper source incomplete', () => {
    const corrupt = { ...helper('broken'), sourceDigest: '0'.repeat(64) }
    const corruptSnapshot = snapshot([run('run-1', 'broken()', [corrupt])])
    expect(corruptSnapshot.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['source-corrupt']
    })

    const huge = helper(
      'huge',
      `def huge():\n    return ${JSON.stringify('x'.repeat(5 * 1024 * 1024))}`
    )
    const bounded = snapshot([run('run-1', 'huge()', [huge])])
    expect(bounded.helperModules).toBeUndefined()
    expect(bounded.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['payload-limit']
    })
  })

  it('decodes helper corruption as explicit incomplete provenance', () => {
    const value = snapshot([run('run-1', 'helper_a()', [helper('helper-a')])])
    value.helperModules![0]!.source = 'tampered source'

    const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))

    expect(decoded.helperModules).toEqual([])
    expect(decoded.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['source-corrupt']
    })
  })

  it('fails closed when helper keys survive without their evidence envelope', () => {
    const value = snapshot([run('run-1', 'helper_a()', [helper('helper-a')])])
    delete value.helperModules
    delete value.helperEvidenceStatus

    const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))

    expect(decoded.helperModules).toEqual([])
    expect(decoded.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['source-missing']
    })
  })

  it('fails closed when helper modules survive without their status', () => {
    const value = snapshot([run('run-1', 'helper_a()', [helper('helper-a')])])
    delete value.helperEvidenceStatus

    const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))

    expect(decoded.helperModules).toHaveLength(1)
    expect(decoded.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['source-missing']
    })
  })

  it('fails closed when a complete status survives without helper modules', () => {
    const value = snapshot([run('run-1', 'helper_a()', [helper('helper-a')])])
    delete value.helperModules

    const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))

    expect(decoded.helperModules).toEqual([])
    expect(decoded.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['source-missing']
    })
  })

  it('projects helper identity without source into renderer-facing execution evidence', () => {
    const value = snapshot([run('run-1', 'helper_a()', [helper('helper-a')])])

    const projected = projectPublicArtifactExecutionSnapshot(value, [])

    expect(projected.helperModules).toEqual([
      {
        helperId: 'helper-a',
        skillIdentity: 'skill:helper-a',
        packageOrigin: 'built-in',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['helper_a'],
        sourceDigest: value.helperModules![0]!.sourceDigest,
        sourceAvailable: true
      }
    ])
    expect(JSON.stringify(projected)).not.toContain('return "helper-a"')
    expect(JSON.stringify(projected)).not.toContain('"source"')
  })
})
