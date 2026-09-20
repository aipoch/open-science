import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type { NotebookHelperModuleEvidence, NotebookRunRecord } from '../../shared/notebook'
import {
  buildBoundedExecutionSnapshot,
  parseArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { projectPublicArtifactExecutionSnapshot } from './provenance-read-model'
import { artifactReproducibilityRecipeMatchesSnapshot } from './artifact-reproducibility-recipe'

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

const snapshot = (
  runs: NotebookRunRecord[],
  provenanceGraph?: PersistedArtifactExecutionSnapshot['provenanceGraph']
): PersistedArtifactExecutionSnapshot =>
  buildBoundedExecutionSnapshot(
    {
      schemaVersion: 2,
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: runs.at(-1)!.runId,
      producerRunIndex: runs.length - 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      ...(provenanceGraph ? { provenanceGraph } : {})
    },
    runs.map((value, runIndex) => ({ run: value, runIndex }))
  )

describe('Artifact helper execution evidence', () => {
  it.each([false, true])(
    'reseals the recipe after successive helper trims (already incomplete: %s)',
    (incomplete) => {
      // The budget removes z, then the producer's b; a remains within the 4 MiB limit.
      const source = `# ${'x'.repeat(2300 * 1024)}`
      const earlier = run('earlier', 'pass', [
        helper('helper-a', source),
        helper('helper-z', source)
      ])
      if (incomplete)
        earlier.helperEvidenceStatus = { state: 'incomplete', reasons: ['source-missing'] }
      const producer = run('producer', 'helper_b()', [helper('helper-b', source)])
      // Publication preserves a file checkpoint after the producer, whose helper barriers
      // must reflect the final helper set rather than the first incomplete snapshot.
      const graph: NonNullable<PersistedArtifactExecutionSnapshot['provenanceGraph']> = {
        schemaVersion: 1,
        targetEntityId: 'artifact-version:version-1',
        completeness: 'complete',
        reasonCodes: [],
        activities: [
          {
            activityId: 'producer',
            kind: 'notebook-run',
            sequence: 1,
            runIndex: 1,
            inclusion: 'target-closure',
            evidenceState: 'available'
          },
          {
            activityId: 'publication',
            kind: 'artifact-publication',
            sequence: 2,
            parentActivityId: 'producer',
            inclusion: 'target-closure',
            evidenceState: 'available'
          }
        ],
        entities: [
          {
            entityId: 'file-generation:result',
            kind: 'file-generation',
            generationId: 'result',
            relativePath: 'result.csv',
            pathPortability: 'relative',
            checksum: 'a'.repeat(64),
            sizeBytes: 10,
            contentStorageKey: `execution-file-evidence/blobs/sha256-${'a'.repeat(64)}`
          },
          {
            entityId: 'artifact-version:version-1',
            kind: 'artifact-version',
            versionId: 'version-1',
            filename: 'result.csv',
            checksum: 'a'.repeat(64),
            sizeBytes: 10
          }
        ],
        edges: [
          {
            kind: 'generated',
            activityId: 'producer',
            entityId: 'file-generation:result',
            authority: 'authoritative',
            evidenceSource: 'runtime-observation'
          },
          {
            kind: 'used',
            activityId: 'publication',
            entityId: 'file-generation:result',
            authority: 'authoritative',
            evidenceSource: 'artifact-publication'
          },
          {
            kind: 'generated',
            activityId: 'publication',
            entityId: 'artifact-version:version-1',
            authority: 'authoritative',
            evidenceSource: 'artifact-publication'
          }
        ]
      }
      const value = snapshot([earlier, producer], graph)
      expect(value.runs.map(({ runId }) => runId)).toEqual(['producer'])
      expect(value.helperModules?.map(({ helperId }) => helperId)).toEqual(['helper-a'])
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(value.helperEvidenceStatus?.state).toBe('incomplete')
      expect(value.reproducibilityRecipe).toBeDefined()
      expect(
        artifactReproducibilityRecipeMatchesSnapshot(value.reproducibilityRecipe!, {
          ...value,
          provenanceGraph: graph
        })
      ).toBe(true)
      expect(() => parseArtifactExecutionSnapshot(JSON.stringify(value))).not.toThrow()
    }
  )

  it.each(['r', 'python'] as const)(
    'preserves bounded per-run %s random state in immutable snapshot round trips',
    (language) => {
      const producer = run(
        'random-run',
        language === 'r' ? 'cat(runif(5))' : 'import random\nprint(random.random())',
        []
      )
      const observation = { locale: 'C', timezone: 'UTC', threadLimits: {}, randomLibraries: [] }
      producer.kernelKind = language
      producer.environmentManifest = {
        schemaVersion: 1,
        captureKind: 'completed-run',
        capturedAt: '2026-09-09T00:00:00Z',
        installedInventory: {
          capturedAt: '2026-09-09T00:00:00Z',
          source: 'full-scan',
          validation: 'full-scan'
        },
        kernelKind: language,
        environmentName: `default-${language}`,
        runtimeSource: 'managed',
        inventorySources: ['kernel-native'],
        packages: [],
        complete: true,
        captureStatus: 'complete',
        executionContext: {
          schemaVersion: 1,
          before: {
            ...observation,
            ...(language === 'r'
              ? {
                  rRandomState: {
                    state: 'available' as const,
                    kinds: ["L'Ecuyer-CMRG", 'Inversion', 'Rejection'] as [
                      "L'Ecuyer-CMRG",
                      'Inversion',
                      'Rejection'
                    ],
                    seed: [10407, 1, 2, 3, 4, 5, 6]
                  }
                }
              : {
                  pythonRandomState: {
                    state: 'available' as const,
                    standard: { words: [...Array<number>(624).fill(1), 624], gaussian: 0.7 },
                    numpy: {
                      words: Array<number>(624).fill(1),
                      position: 2,
                      hasGaussian: 1,
                      gaussian: -0.3
                    }
                  }
                })
          },
          after: observation
        }
      }
      const value = snapshot([producer])
      const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))
      expect(decoded.runs[0]?.executionContext).toEqual(
        producer.environmentManifest.executionContext
      )
      expect(decoded.runs[0]?.script).toBe(producer.script)
      const damaged = JSON.parse(JSON.stringify(value))
      if (language === 'r') damaged.runs[0].executionContext.before.rRandomState.seed = [10407]
      else damaged.runs[0].executionContext.before.pythonRandomState.standard.words = [1]
      expect(() => parseArtifactExecutionSnapshot(JSON.stringify(damaged))).toThrow()
    }
  )

  it('preserves explicit non-dispatch evidence through immutable snapshot serialization', () => {
    const failed = {
      ...run('failed-run', 'seed = 40', []),
      status: 'failed' as const,
      kernelDispatched: false
    }
    const legacy = run('legacy-run', 'seed = 0', [])
    delete legacy.kernelDispatched
    const value = snapshot([failed, run('producer', 'print(2)', []), legacy])
    const decoded = parseArtifactExecutionSnapshot(JSON.stringify(value))
    expect(decoded.runs[0]).toHaveProperty('kernelDispatched', false)
    expect(decoded.runs[1]).toHaveProperty('kernelDispatched', true)
    expect(decoded.runs[2]).not.toHaveProperty('kernelDispatched')
  })

  it('carries each run Environment lock reference into the bounded Artifact snapshot', () => {
    const producer = run('run-1', 'write_result()', [])
    producer.environmentLock = {
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: 'a'.repeat(64)
    }

    expect(snapshot([producer]).runs[0]?.environmentLock).toEqual(producer.environmentLock)
  })

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
    value.provenanceGraph = {
      schemaVersion: 1,
      targetEntityId: 'artifact-version:version-1',
      completeness: 'incomplete',
      reasonCodes: ['target-generation-unavailable'],
      activities: [],
      entities: [
        {
          entityId: 'artifact-version:version-1',
          kind: 'artifact-version',
          versionId: 'version-1',
          filename: 'result.csv',
          checksum: 'a'.repeat(64),
          sizeBytes: 10
        }
      ],
      edges: []
    }

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
    expect(JSON.stringify(projected)).not.toContain('contentStorageKey')
    expect(projected).not.toHaveProperty('provenanceGraph')
    expect(projected.reproducibility).toMatchObject({
      targetEntityId: 'artifact-version:version-1',
      completeness: 'incomplete'
    })
  })
})
