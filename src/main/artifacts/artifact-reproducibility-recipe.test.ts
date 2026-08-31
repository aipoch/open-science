import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  ArtifactReproducibilityRecipe,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { artifactProvenanceGraphValue } from './artifact-provenance-graph'
import {
  artifactReproducibilityRecipeMatchesSnapshot,
  artifactReproducibilityRecipeValue,
  prepareArtifactReproducibilityExecutionPlan,
  resolveArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe,
  validateArtifactReproducibilityRecipeStorage
} from './artifact-reproducibility-recipe'

const checksum = (character: string): string => character.repeat(64)

const resignRecipe = (recipe: ArtifactReproducibilityRecipe): ArtifactReproducibilityRecipe => {
  const { recipeId: _recipeId, ...draft } = recipe
  void _recipeId
  return {
    ...draft,
    recipeId: sha256(canonicalJson(draft as unknown as CanonicalJson))
  }
}

const graph = (): ArtifactProvenanceGraph => ({
  schemaVersion: 1,
  targetEntityId: 'artifact-version:version-1',
  completeness: 'complete',
  reasonCodes: [],
  activities: [
    {
      activityId: 'run-1',
      kind: 'notebook-run',
      sequence: 0,
      runIndex: 0,
      inclusion: 'target-closure',
      evidenceState: 'available'
    },
    {
      activityId: 'run-2',
      kind: 'notebook-run',
      sequence: 1,
      runIndex: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    },
    {
      activityId: 'artifact-publication:version-1',
      kind: 'artifact-publication',
      sequence: 2,
      parentActivityId: 'run-2',
      inclusion: 'target-closure',
      evidenceState: 'available'
    }
  ],
  entities: [
    {
      entityId: 'registered-input:upload-version:input-1',
      kind: 'registered-input-generation',
      inputFileVersionId: 'input-1',
      sourceKind: 'upload-version',
      filename: 'source.csv',
      checksum: checksum('a'),
      sizeBytes: 10
    },
    {
      entityId: 'file-generation:middle',
      kind: 'file-generation',
      generationId: 'middle',
      relativePath: 'intermediate/clean.csv',
      pathPortability: 'relative',
      checksum: checksum('b'),
      sizeBytes: 20,
      contentStorageKey: `execution-file-evidence/blobs/sha256-${checksum('b')}`
    },
    {
      entityId: 'file-generation:result',
      kind: 'file-generation',
      generationId: 'result',
      relativePath: 'result.csv',
      pathPortability: 'relative',
      checksum: checksum('c'),
      sizeBytes: 30,
      contentStorageKey: `execution-file-evidence/blobs/sha256-${checksum('c')}`
    },
    {
      entityId: 'artifact-version:version-1',
      kind: 'artifact-version',
      versionId: 'version-1',
      filename: 'result.csv',
      checksum: checksum('c'),
      sizeBytes: 30
    }
  ],
  edges: [
    {
      kind: 'used',
      activityId: 'run-1',
      entityId: 'registered-input:upload-version:input-1',
      authority: 'authoritative',
      evidenceSource: 'registered-contract'
    },
    {
      kind: 'generated',
      activityId: 'run-1',
      entityId: 'file-generation:middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'run-2',
      entityId: 'file-generation:middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'file-generation:result',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'artifact-publication:version-1',
      entityId: 'file-generation:result',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    },
    {
      kind: 'generated',
      activityId: 'artifact-publication:version-1',
      entityId: 'artifact-version:version-1',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  ]
})

const run = (
  runId: string,
  runIndex: number,
  kernelKind: 'python' | 'r' = 'python'
): ProvenanceNotebookRun => ({
  runId,
  runIndex,
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  kernelKind,
  environmentName: kernelKind === 'python' ? 'default-python' : 'default-r',
  environmentLock: {
    state: 'available',
    format: 'environment-lock-bundle',
    lockChecksum: kernelKind === 'python' ? checksum('d') : checksum('e')
  },
  script: `${kernelKind === 'python' ? 'print' : 'cat'}('${runId}')`,
  status: 'completed',
  startedAt: '2026-09-02T00:00:00.000Z',
  completedAt: '2026-09-02T00:00:01.000Z',
  outputs: [],
  inputFileVersionKeys: []
})

const inputFiles: PersistedArtifactExecutionSnapshot['inputFiles'] = [
  {
    inputFileVersionId: 'input-1',
    sourceKind: 'upload-version',
    sourceFileId: 'upload-1',
    sourceProjectId: 'project-1',
    sourceSessionId: 'session-1',
    filename: 'source.csv',
    sizeBytes: 10,
    checksum: checksum('a'),
    storageKey: 'uploads/project-1/upload-1/version-1/content',
    association: 'resolver-accessed'
  }
]

describe('Artifact reproducibility recipe', () => {
  it('seals deterministic target steps, environment requirements, and every safe frontier', () => {
    const value = graph()
    const runs = [run('run-1', 0), run('run-2', 1, 'r')]
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles,
      runs
    })

    expect(recipe).toMatchObject({
      schemaVersion: 1,
      targetVersionId: 'version-1',
      targetSourceEntityId: 'file-generation:result',
      graphChecksum: sha256(canonicalJson(value as unknown as CanonicalJson)),
      capture: { state: 'sealed', reasonCodes: [] }
    })
    expect(recipe.steps).toEqual([
      expect.objectContaining({
        kind: 'notebook-run',
        activityId: 'run-1',
        kernelKind: 'python',
        sourceChecksum: sha256(runs[0]!.script),
        environmentRequirementId: `environment-lock:${checksum('d')}`
      }),
      expect.objectContaining({
        kind: 'notebook-run',
        activityId: 'run-2',
        kernelKind: 'r',
        sourceChecksum: sha256(runs[1]!.script),
        environmentRequirementId: `environment-lock:${checksum('e')}`
      })
    ])
    expect(recipe.environmentRequirements).toHaveLength(2)
    expect(recipe.frontiers).toEqual([
      expect.objectContaining({
        frontierId: 'original-inputs',
        stepIds: ['step:run-1', 'step:run-2'],
        crossingFiles: [
          expect.objectContaining({
            entityId: 'registered-input:upload-version:input-1',
            materializationPath: `inputs/source-${checksum('a').slice(0, 12)}.csv`
          })
        ],
        reasonCodes: []
      }),
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        stepIds: ['step:run-2'],
        crossingFiles: [
          expect.objectContaining({
            entityId: 'file-generation:middle',
            materializationPath: 'intermediate/clean.csv'
          })
        ]
      }),
      expect.objectContaining({
        frontierId: 'checkpoint:run-2',
        stepIds: [],
        crossingFiles: [
          expect.objectContaining({
            entityId: 'file-generation:result',
            materializationPath: 'result.csv'
          })
        ]
      })
    ])
    expect(JSON.stringify(recipe)).not.toContain(runs[0]!.script)
    expect(artifactReproducibilityRecipeValue(recipe)).toBe(true)
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-1')).toMatchObject({
      frontier: { frontierId: 'checkpoint:run-1' },
      steps: [{ stepId: 'step:run-2' }],
      environmentRequirements: [{ requirementId: `environment-lock:${checksum('e')}` }]
    })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-2')).toBeUndefined()
    expect(
      artifactReproducibilityRecipeMatchesSnapshot(recipe, {
        provenanceGraph: value,
        inputFiles,
        runs
      })
    ).toBe(true)
  })

  it('blocks an end-to-end plan at partial locks while keeping a later frozen checkpoint usable', () => {
    const runs = [run('run-1', 0), run('run-2', 1)]
    runs[0]!.environmentLock = {
      state: 'partial',
      format: 'environment-lock-bundle',
      lockChecksum: checksum('d'),
      partialReasons: ['non-conda-package-detected']
    }
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph(),
      inputFiles,
      runs
    })

    expect(recipe.capture.state).toBe('sealed')
    expect(recipe.frontiers[0]).toMatchObject({
      frontierId: 'original-inputs',
      reasonCodes: ['environment-lock-partial']
    })
    expect(recipe.frontiers.at(-1)).toMatchObject({
      frontierId: 'checkpoint:run-2',
      reasonCodes: []
    })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeUndefined()
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-1')).toMatchObject({
      frontier: { frontierId: 'checkpoint:run-1' },
      steps: [{ stepId: 'step:run-2' }]
    })
  })

  it('does not execute unsupported kernels but preserves an independent later frontier', () => {
    const runs: ProvenanceNotebookRun[] = [
      { ...run('run-1', 0), kernelKind: 'bash', environmentLock: undefined },
      run('run-2', 1)
    ]
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph(),
      inputFiles,
      runs
    })

    expect(recipe.capture.state).toBe('sealed')
    expect(recipe.frontiers[0]).toMatchObject({
      frontierId: 'original-inputs',
      reasonCodes: ['unsupported-kernel-kind']
    })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeUndefined()
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-1')).toMatchObject({
      frontier: { frontierId: 'checkpoint:run-1' },
      steps: [{ stepId: 'step:run-2' }]
    })
  })

  it('treats advisory generated entities as outputs to compare, not input dependencies', () => {
    const value = graph()
    for (const edge of value.edges) {
      if (edge.kind === 'generated' && edge.evidenceSource === 'runtime-observation') {
        edge.authority = 'advisory'
      }
    }
    const runs = [run('run-1', 0), run('run-2', 1)]
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles,
      runs
    })

    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()

    const advisoryInput = value.edges.find(
      (edge) => edge.kind === 'used' && edge.activityId === 'run-2'
    )
    if (!advisoryInput || advisoryInput.kind !== 'used') throw new Error('Missing input edge.')
    advisoryInput.authority = 'advisory'
    const blocked = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles,
      runs
    })

    expect(resolveArtifactReproducibilityExecutionPlan(blocked, 'original-inputs')).toBeUndefined()
    expect(blocked.frontiers[0]?.reasonCodes).toContain('advisory-dependency')
  })

  it('localizes missing helper evidence and ignores output-only snapshot trimming', () => {
    const runs = [run('run-1', 0), run('run-2', 1)]
    runs[0]!.helperModuleKeys = ['missing-helper-key']
    const localized = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph(),
      inputFiles,
      runs,
      helperModules: [],
      helperEvidenceStatus: { state: 'incomplete', reasons: ['payload-limit'] }
    })

    expect(localized.frontiers[0]?.reasonCodes).toContain('helper-source-incomplete')
    expect(
      resolveArtifactReproducibilityExecutionPlan(localized, 'original-inputs')
    ).toBeUndefined()
    expect(resolveArtifactReproducibilityExecutionPlan(localized, 'checkpoint:run-1')).toBeDefined()

    const outputTrimmed = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph(),
      inputFiles,
      runs: [run('run-1', 0), run('run-2', 1)],
      truncation: {
        reason: 'payload-limit',
        omittedLeadingRunCount: 0,
        omittedOutputCount: 1,
        omittedInputCount: 0
      }
    })

    expect(outputTrimmed.capture.state).toBe('sealed')
    expect(outputTrimmed.capture.reasonCodes).not.toContain('execution-evidence-truncated')
    expect(
      resolveArtifactReproducibilityExecutionPlan(outputTrimmed, 'original-inputs')
    ).toBeDefined()
  })

  it('blocks only checkpoints with ambiguous or in-memory dependency boundaries', () => {
    const ambiguous = graph()
    ambiguous.activities[1]!.sequence = 0
    ambiguous.activities[2]!.sequence = 1
    const ambiguousRecipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: ambiguous,
      inputFiles,
      runs: [run('run-1', 0), run('run-2', 1)]
    })

    expect(artifactReproducibilityRecipeValue(ambiguousRecipe)).toBe(true)
    expect(ambiguousRecipe.capture.state).toBe('sealed')
    expect(ambiguousRecipe.frontiers).toContainEqual(
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        reasonCodes: ['ambiguous-activity-order']
      })
    )
    expect(
      resolveArtifactReproducibilityExecutionPlan(ambiguousRecipe, 'original-inputs')
    ).toBeDefined()
    expect(
      resolveArtifactReproducibilityExecutionPlan(ambiguousRecipe, 'checkpoint:run-1')
    ).toBeUndefined()

    const inMemoryBoundary = graph()
    inMemoryBoundary.edges.push({
      kind: 'depends-on',
      activityId: 'run-2',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    })
    const inMemoryRecipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: inMemoryBoundary,
      inputFiles,
      runs: [run('run-1', 0), run('run-2', 1)]
    })

    expect(inMemoryRecipe.frontiers).toContainEqual(
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        reasonCodes: ['advisory-dependency']
      })
    )
    expect(
      resolveArtifactReproducibilityExecutionPlan(inMemoryRecipe, 'checkpoint:run-1')
    ).toBeUndefined()
  })

  it('fails closed for incomplete evidence, missing runs, absolute writes, and compute activities', () => {
    const value = graph()
    value.completeness = 'incomplete'
    value.reasonCodes = ['absolute-path-unfrozen']
    const result = value.entities.find((entity) => entity.entityId === 'file-generation:result')
    if (result?.kind !== 'file-generation') throw new Error('missing result fixture')
    result.pathPortability = 'absolute'
    result.relativePath = '/Users/researcher/result.csv'
    const generated = value.edges.find(
      (edge) => edge.kind === 'generated' && edge.entityId === result.entityId
    )
    if (generated?.kind !== 'generated') throw new Error('missing generation edge')
    generated.pathPortability = 'absolute'
    value.activities.splice(1, 0, {
      activityId: 'compute-1',
      kind: 'compute-job',
      sequence: 1,
      parentActivityId: 'run-1',
      inclusion: 'target-closure',
      evidenceState: 'available'
    })
    value.activities[2]!.sequence = 2
    value.activities[3]!.sequence = 3

    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles,
      runs: [run('run-2', 1)]
    })

    expect(recipe.capture).toMatchObject({
      state: 'blocked',
      reasonCodes: expect.arrayContaining([
        'target-graph-incomplete',
        'required-run-missing',
        'absolute-write-not-isolated',
        'compute-recipe-unavailable'
      ])
    })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeUndefined()
    expect(JSON.stringify(recipe)).not.toContain('/Users/researcher')
  })

  it('rejects changed recipe identities and snapshot source mismatches', () => {
    const value = graph()
    const runs = [run('run-1', 0), run('run-2', 1)]
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles,
      runs
    })

    expect(artifactReproducibilityRecipeValue({ ...recipe, targetChecksum: checksum('f') })).toBe(
      false
    )
    expect(
      artifactReproducibilityRecipeMatchesSnapshot(recipe, {
        provenanceGraph: value,
        inputFiles,
        runs: [runs[0]!, { ...runs[1]!, script: 'changed' }]
      })
    ).toBe(false)
  })

  it('rejects conflicting frozen file declarations before validating shared storage', async () => {
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph(),
      inputFiles,
      runs: [run('run-1', 0), run('run-2', 1)]
    })
    const forged = structuredClone(recipe)
    const files = forged.frontiers.flatMap((frontier) => frontier.crossingFiles)
    const first = files[0]
    const second = files.find((file) => file.entityId !== first?.entityId)
    if (!first || !second) throw new Error('Expected distinct frozen file fixtures.')
    second.contentStorageKey = first.contentStorageKey
    const resigned = resignRecipe(forged)

    expect(artifactReproducibilityRecipeValue(resigned)).toBe(false)
    await expect(validateArtifactReproducibilityRecipeStorage(resigned, '/unused')).rejects.toThrow(
      /recipe is invalid/i
    )
  })

  it('fails closed when frozen files or Environment locks are missing or corrupt', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-recipe-storage-'))
    const value = graph()
    const storedInputs = structuredClone(inputFiles)
    const files = new Map([
      ['registered-input:upload-version:input-1', Buffer.from('source')],
      ['file-generation:middle', Buffer.from('middle')],
      ['file-generation:result', Buffer.from('result')]
    ])
    for (const entity of value.entities) {
      const bytes = files.get(entity.entityId)
      if (!bytes) continue
      entity.checksum = sha256(bytes)
      entity.sizeBytes = bytes.byteLength
      if (entity.kind === 'file-generation') {
        entity.contentStorageKey = `execution-file-evidence/project-1/blobs/sha256-${entity.checksum}`
      } else if (entity.kind === 'registered-input-generation') {
        storedInputs[0]!.checksum = entity.checksum
        storedInputs[0]!.sizeBytes = entity.sizeBytes
      }
    }
    const target = value.entities.find((entity) => entity.kind === 'artifact-version')
    const result = value.entities.find((entity) => entity.entityId === 'file-generation:result')
    if (!target || target.kind !== 'artifact-version' || result?.kind !== 'file-generation') {
      throw new Error('Invalid storage fixture.')
    }
    target.checksum = result.checksum
    target.sizeBytes = result.sizeBytes

    const lock = `${JSON.stringify(
      {
        schemaVersion: 1,
        format: 'environment-lock-bundle',
        kernelKind: 'python',
        environmentName: 'default-python',
        components: [
          {
            ecosystem: 'conda',
            format: 'conda-explicit-md5',
            resolution: 'locked',
            explicitLock:
              '@EXPLICIT\nhttps://conda.example/osx-arm64/python-1.0-0.conda#00000000000000000000000000000000\n',
            packages: ['python']
          }
        ]
      },
      null,
      2
    )}\n`
    const lockChecksum = sha256(lock)
    const runs = [run('run-1', 0), run('run-2', 1)].map((value) => ({
      ...value,
      environmentLock: {
        state: 'available' as const,
        format: 'environment-lock-bundle' as const,
        lockChecksum
      }
    }))
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: value,
      inputFiles: storedInputs,
      runs
    })
    const writeStored = async (key: string, content: string | Buffer): Promise<void> => {
      const path = join(storageRoot, ...key.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    for (const frontier of recipe.frontiers) {
      for (const file of frontier.crossingFiles) {
        await writeStored(file.contentStorageKey, files.get(file.entityId)!)
      }
    }
    const lockKey = `runtime/provenance/environment-locks/${lockChecksum}.json`
    await writeStored(lockKey, lock)

    await expect(validateArtifactReproducibilityRecipeStorage(recipe, storageRoot)).resolves.toBe(
      undefined
    )
    await expect(
      prepareArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-1', storageRoot)
    ).resolves.toMatchObject({
      frontier: { frontierId: 'checkpoint:run-1' },
      steps: [{ stepId: 'step:run-2' }]
    })
    await expect(
      prepareArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-2', storageRoot)
    ).rejects.toThrow(/frontier is not executable/i)
    const frozen = recipe.frontiers.flatMap((frontier) => frontier.crossingFiles)[0]!
    await rm(join(storageRoot, ...frozen.contentStorageKey.split('/')))
    await expect(
      prepareArtifactReproducibilityExecutionPlan(recipe, 'checkpoint:run-1', storageRoot)
    ).resolves.toMatchObject({ frontier: { frontierId: 'checkpoint:run-1' } })
    await expect(validateArtifactReproducibilityRecipeStorage(recipe, storageRoot)).rejects.toThrow(
      /frozen file is unavailable/i
    )
    await writeStored(frozen.contentStorageKey, Buffer.alloc(frozen.sizeBytes, 0))
    await expect(validateArtifactReproducibilityRecipeStorage(recipe, storageRoot)).rejects.toThrow(
      /frozen file checksum mismatch/i
    )
    await writeStored(frozen.contentStorageKey, files.get(frozen.entityId)!)
    await rm(join(storageRoot, ...lockKey.split('/')))
    await expect(validateArtifactReproducibilityRecipeStorage(recipe, storageRoot)).rejects.toThrow(
      /Environment lock is unavailable/i
    )
    await writeStored(lockKey, `${lock} `)
    await expect(validateArtifactReproducibilityRecipeStorage(recipe, storageRoot)).rejects.toThrow(
      /Environment lock checksum mismatch/i
    )
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('persists only a blocked identity when a valid graph would exceed the recipe budget', () => {
    const value = graph()
    const middle = value.entities.find((entity) => entity.entityId === 'file-generation:middle')
    if (middle?.kind !== 'file-generation') throw new Error('Missing middle fixture.')
    const generatedIndex = value.edges.findIndex(
      (edge) => edge.kind === 'generated' && edge.entityId === middle.entityId
    )
    const usedIndex = value.edges.findIndex(
      (edge) => edge.kind === 'used' && edge.entityId === middle.entityId
    )
    value.entities = value.entities.filter((entity) => entity !== middle)
    value.edges = value.edges.filter((_, index) => index !== generatedIndex && index !== usedIndex)
    for (let index = 0; index < 1_400; index += 1) {
      const generationId = `intermediate-${index.toString().padStart(4, '0')}`
      const entityId = `file-generation:${generationId}`
      value.entities.push({
        ...middle,
        entityId,
        generationId,
        relativePath: `intermediate/${generationId}.csv`
      })
      value.edges.push(
        {
          kind: 'generated',
          activityId: 'run-1',
          entityId,
          authority: 'authoritative',
          evidenceSource: 'runtime-observation'
        },
        {
          kind: 'used',
          activityId: 'run-2',
          entityId,
          authority: 'authoritative',
          evidenceSource: 'runtime-observation'
        }
      )
    }

    expect(artifactProvenanceGraphValue(value)).toBe(true)
    expect(
      sealArtifactReproducibilityRecipe({
        provenanceGraph: value,
        inputFiles,
        runs: [run('run-1', 0), run('run-2', 1)]
      })
    ).toMatchObject({
      steps: [],
      frontiers: [],
      environmentRequirements: [],
      capture: { state: 'blocked', reasonCodes: ['recipe-budget-exceeded'] }
    })
  })
})
