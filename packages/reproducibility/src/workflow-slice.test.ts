import { mkdir, mkdtemp, readFile, rm, writeFile, access, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, statfs: vi.fn(fs.statfs) }
})
import { createWorkflowSlices, sealWorkflowCapture, validWorkflowCapture } from './workflow-slice'
import { createWorkflowSliceExecutor } from './execution'
import { deriveCondaRuntimeSubsetPlan } from '@aipoch/environment'
import type { NotebookEnvironmentLock } from '@aipoch/environment/contracts'
import { sha256 } from './canonical'
import { fileIO, reproductionEvidence } from './test-support'
import type { NotebookReproductionRuntime, ReproductionEvidence } from './ports'
import type {
  ArtifactProvenanceGraphEntity,
  ProvenanceNotebookRun,
  WorkflowCapture,
  WorkflowPlan
} from './evidence'

const lock = JSON.stringify({
  schemaVersion: 1,
  format: 'environment-lock-bundle',
  kernelKind: 'python',
  environmentName: 'analysis',
  components: [
    {
      ecosystem: 'conda',
      format: 'conda-explicit-md5',
      resolution: 'locked',
      packages: ['python'],
      explicitLock:
        '@EXPLICIT\nhttps://conda.example/python-1.0-0.conda#00000000000000000000000000000000\n'
    }
  ]
})
const lockChecksum = sha256(lock)
const inputPath = (): string => 'inputs/raw.csv'
const slices = createWorkflowSlices({ fileIO, inputPath })
const executeWorkflowSlice = createWorkflowSliceExecutor({ fileIO, inputPath })
const bytes = {
  raw: Buffer.from('raw\n'),
  clean: Buffer.from('clean\n'),
  de: Buffer.from('42\n'),
  plot: Buffer.from('volcano\n'),
  sibling: Buffer.from('heatmap\n')
}
const file = (
  name: keyof typeof bytes
): Extract<ArtifactProvenanceGraphEntity, { kind: 'file-generation' }> => ({
  entityId: `file:${name}`,
  kind: 'file-generation',
  generationId: name,
  relativePath: `data/${name}.csv`,
  pathPortability: 'relative',
  checksum: sha256(bytes[name]),
  sizeBytes: bytes[name].length,
  contentStorageKey: `frozen/${name}`
})
const run = (runId: string, runIndex: number): ProvenanceNotebookRun => ({
  runId,
  runIndex,
  agentFrameId: 'frame',
  messageBranchId: 'branch',
  runtimeSegmentId: 'segment',
  promptMessageId: `prompt:${runId}`,
  kernelKind: 'python',
  kernelEpochId: 'epoch',
  environmentName: 'analysis',
  environmentLock: { state: 'available', format: 'environment-lock-bundle', lockChecksum },
  script: `# exact original ${runId} source`,
  status: 'completed',
  startedAt: '2026-10-20T00:00:00.000Z',
  outputs: [],
  inputFileVersionKeys: []
})
const draft = (): Omit<WorkflowCapture, 'captureId'> => ({
  schemaVersion: 1,
  runs: ['setup', 'clean', 'de', 'plot', 'sibling'].map(run),
  inputFiles: [
    {
      sourceKind: 'upload-version',
      inputFileVersionId: 'raw-v1',
      sourceFileId: 'raw',
      sourceProjectId: 'p',
      sourceSessionId: 's',
      filename: 'raw.csv',
      checksum: sha256(bytes.raw),
      sizeBytes: bytes.raw.length,
      storageKey: 'uploads/raw',
      association: 'resolver-accessed'
    }
  ],
  graph: {
    schemaVersion: 1,
    targetEntityId: 'artifact:final',
    completeness: 'complete',
    reasonCodes: [],
    activities: [
      ...['setup', 'clean', 'de', 'plot', 'sibling'].map((activityId, sequence) => ({
        activityId,
        kind: 'notebook-run' as const,
        sequence,
        runIndex: sequence,
        inclusion: 'workflow-capture' as const,
        evidenceState: 'available' as const
      })),
      {
        activityId: 'publication',
        kind: 'artifact-publication',
        sequence: 5,
        inclusion: 'target-closure',
        evidenceState: 'available'
      }
    ],
    entities: [
      {
        entityId: 'input:raw',
        kind: 'registered-input-generation',
        inputFileVersionId: 'raw-v1',
        sourceKind: 'upload-version',
        filename: 'raw.csv',
        checksum: sha256(bytes.raw),
        sizeBytes: bytes.raw.length
      },
      ...(['clean', 'de', 'plot', 'sibling'] as const).map(file),
      {
        entityId: 'artifact:final',
        kind: 'artifact-version',
        versionId: 'final',
        filename: 'sibling.csv',
        checksum: sha256(bytes.sibling),
        sizeBytes: bytes.sibling.length
      }
    ],
    edges: [
      {
        kind: 'used',
        activityId: 'clean',
        entityId: 'input:raw',
        authority: 'authoritative',
        evidenceSource: 'registered-contract'
      },
      {
        kind: 'generated',
        activityId: 'clean',
        entityId: 'file:clean',
        authority: 'advisory',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'used',
        activityId: 'de',
        entityId: 'file:clean',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'depends-on',
        activityId: 'de',
        dependencyActivityId: 'setup',
        authority: 'authoritative',
        evidenceSource: 'dependency-analysis'
      },
      {
        kind: 'generated',
        activityId: 'de',
        entityId: 'file:de',
        authority: 'advisory',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'used',
        activityId: 'plot',
        entityId: 'file:de',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'generated',
        activityId: 'plot',
        entityId: 'file:plot',
        authority: 'advisory',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'used',
        activityId: 'sibling',
        entityId: 'file:clean',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'generated',
        activityId: 'sibling',
        entityId: 'file:sibling',
        authority: 'advisory',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'used',
        activityId: 'publication',
        entityId: 'file:sibling',
        authority: 'authoritative',
        evidenceSource: 'artifact-publication'
      },
      {
        kind: 'generated',
        activityId: 'publication',
        entityId: 'artifact:final',
        authority: 'authoritative',
        evidenceSource: 'artifact-publication'
      }
    ]
  }
})
const capture = (): WorkflowCapture => sealWorkflowCapture(draft())
const inPlaceDraft = (): Omit<WorkflowCapture, 'captureId'> => {
  const input = draft()
  input.graph.edges = input.graph.edges.filter((edge) => edge.kind !== 'depends-on')
  for (const entity of input.graph.entities)
    if (entity.kind === 'file-generation' && ['file:de', 'file:plot'].includes(entity.entityId))
      entity.relativePath = 'data/clean.csv'
  return input
}
const plan = (
  value: WorkflowCapture,
  targets: string[],
  boundaryEntityIds: string[] = []
): WorkflowPlan =>
  slices.planWorkflowSlice(value, {
    captureId: value.captureId,
    targetRunIds: targets,
    boundaryEntityIds
  })
const evidenceAt = async (root: string): Promise<ReproductionEvidence> => {
  for (const [key, content] of [
    ['uploads/raw', bytes.raw],
    ...Object.entries(bytes).map(([name, content]) => [`frozen/${name}`, content] as const),
    [`runtime/provenance/environment-locks/${lockChecksum}.json`, Buffer.from(lock)]
  ] as const) {
    const path = join(root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return reproductionEvidence(root)
}

const stateBytes = Buffer.from('opaque R stage fixture')
const stateChecksum = sha256(stateBytes)
const stateKey = `runtime/provenance/r-stage-checkpoints/${stateChecksum}.rds`
const rLock = lock.replace('"kernelKind":"python"', '"kernelKind":"r"')
const rDraft = (): Omit<WorkflowCapture, 'captureId'> => {
  const input = draft()
  for (const run of input.runs) {
    run.kernelKind = 'r'
    run.environmentLock = {
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: sha256(rLock)
    }
    run.stageCheckpoint = {
      state: 'available',
      schemaVersion: 1,
      runId: run.runId,
      kernelEpochId: run.kernelEpochId!,
      sourceChecksum: sha256(run.script),
      environmentLockChecksum: sha256(rLock),
      input: { storageKey: stateKey, checksum: stateChecksum, sizeBytes: stateBytes.length },
      output: { storageKey: stateKey, checksum: stateChecksum, sizeBytes: stateBytes.length },
      inputNames: ['dds'],
      outputNames: ['result']
    }
  }
  return input
}
const rEvidenceAt = async (root: string): Promise<ReproductionEvidence> => {
  const evidence = await evidenceAt(root)
  for (const [key, content] of [
    [stateKey, stateBytes],
    [`runtime/provenance/environment-locks/${sha256(rLock)}.json`, Buffer.from(rLock)]
  ] as const) {
    await mkdir(dirname(join(root, key)), { recursive: true })
    await writeFile(join(root, key), content)
  }
  return evidence
}

describe('frozen R stage object boundaries', () => {
  it.each([
    'matched',
    'projected',
    'projection-missing',
    'projected-reference-different',
    'state-different',
    'file-different',
    'native-unverified',
    'cancel-during-shutdown',
    'unreaped',
    'hint-matched',
    'hint-state-different',
    'hint-file-different',
    'hint-native-unverified',
    'hint-cancel-during-shutdown',
    'hint-cancel-restore-io-error',
    'hint-cancel-unreaped',
    'hint-unreaped',
    'hint-source-mismatch',
    'hint-scope-mismatch',
    'hint-corrupt',
    'hint-io-error',
    'save-io-error'
  ] as const)(
    'accepts a scoped runtime candidate only after independent conformance: %s',
    async (mode) => {
      const condition =
        mode === 'hint-cancel-restore-io-error'
          ? 'cancel-during-shutdown'
          : mode.startsWith('hint-')
            ? mode.slice(5)
            : mode === 'save-io-error'
              ? 'matched'
              : mode
      const root = await mkdtemp(join(tmpdir(), 'r-subset-conformance-'))
      try {
        const packages = ['r-base', 'r-jsonlite', 'unused'].map((name) => ({
          name,
          version: '1.0',
          build: '0',
          md5: '0'.repeat(32),
          depends: [],
          url: `https://conda.example/${name}-1.0-0.conda`
        }))
        const original: NotebookEnvironmentLock = {
          schemaVersion: 1,
          format: 'environment-lock-bundle',
          kernelKind: 'r',
          environmentName: 'analysis',
          components: [
            {
              ecosystem: 'conda',
              format: 'conda-explicit-md5',
              resolution: 'locked',
              packages: packages.map(({ name }) => name),
              explicitLock:
                '@EXPLICIT\n' + packages.map((pkg) => `${pkg.url}#${pkg.md5}\n`).join(''),
              dependencyGraph: {
                schemaVersion: 1,
                packages,
                rPackageOwnership: {
                  schemaVersion: 1,
                  packages: [
                    { name: 'base', version: '1.0', condaPackage: 'r-base' },
                    { name: 'jsonlite', version: '1.0', condaPackage: 'r-jsonlite' }
                  ]
                }
              }
            }
          ]
        }
        const serialized = JSON.stringify(original)
        const originalChecksum = sha256(serialized)
        const input = rDraft()
        for (const run of input.runs) {
          run.environmentLock = {
            state: 'available',
            format: 'environment-lock-bundle',
            lockChecksum: originalChecksum
          }
          if (run.stageCheckpoint?.state === 'available') {
            run.stageCheckpoint.environmentLockChecksum = originalChecksum
            run.stageCheckpoint.environmentProof = {
              schemaVersion: 1,
              packages: [
                { name: 'base', version: '1.0' },
                { name: 'jsonlite', version: '1.0' }
              ]
            }
          }
        }
        if (
          condition === 'projected' ||
          condition === 'projection-missing' ||
          condition === 'projected-reference-different'
        ) {
          const selectedRun = input.runs.find(({ runId }) => runId === 'de')!
          if (selectedRun.stageCheckpoint?.state !== 'available') throw new Error('fixture')
          selectedRun.stageCheckpoint.inputNames = []
          const observation = {
            locale: 'C',
            timezone: 'UTC',
            threadLimits: {},
            randomLibraries: []
          }
          const warm = [
            'DESeq2',
            'jsonlite',
            'stats',
            'graphics',
            'grDevices',
            'utils',
            'datasets',
            'methods',
            'base'
          ]
          selectedRun.executionContext = {
            schemaVersion: 1,
            before: observation,
            after: observation,
            rPackages: { complete: true, before: warm, after: warm, reads: [], cleanSession: false }
          }
        }
        const value = sealWorkflowCapture(input)
        const selected = slices.planWorkflowSlice(value, {
          captureId: value.captureId,
          targetRunIds: ['de'],
          independent: true
        })
        expect(selected.status).toBe('ready')
        const evidence = await rEvidenceAt(root)
        await writeFile(
          join(root, `runtime/provenance/environment-locks/${originalChecksum}.json`),
          serialized
        )
        const roots: string[] = []
        const sequence: string[] = []
        const owner = createWorkflowSliceExecutor({ fileIO, inputPath })
        const controller = new AbortController()
        let calls = 0
        let persisted: unknown
        const save = vi.fn(async (candidate: unknown) => {
          if (mode === 'save-io-error') throw new Error('cache unavailable')
          persisted = structuredClone(candidate)
        })
        const restoreCancelled = vi.fn(async () => {
          if (mode === 'hint-cancel-restore-io-error') throw new Error('restore hint IO failed')
        })
        const dependencies = {
          runtimeSubsetContextChecksum: 'a'.repeat(64),
          loadRuntimeSubsetCandidate: async (scope: string) => {
            if (!mode.startsWith('hint-')) return persisted
            if (condition === 'io-error') throw new Error('cache unavailable')
            if (condition === 'corrupt') return { archiveNames: ['untrusted'] }
            const hint = deriveCondaRuntimeSubsetPlan(
              original,
              originalChecksum,
              scope,
              packages.slice(0, 2).map((pkg) => `${pkg.name}-1.0-0.conda`)
            )!
            if (condition === 'source-mismatch') hint.sourceLockChecksum = '0'.repeat(64)
            if (condition === 'scope-mismatch') hint.scopeChecksum = '0'.repeat(64)
            return hint
          },
          saveRuntimeSubsetCandidate: save,
          restoreCancelledRuntimeSubsetCandidate: restoreCancelled,
          createAttemptRoot: async (): Promise<string> => {
            if (roots.length)
              await expect(access(roots.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' })
            const attempt = await mkdtemp(join(root, 'attempt-'))
            roots.push(attempt)
            return attempt
          },
          createRuntime: async (
            request: Parameters<import('./ports').CreateReproductionRuntime>[0]
          ): Promise<NotebookReproductionRuntime> => {
            calls++
            const candidate = !!request.runtimeSubset?.plan
            sequence.push(candidate ? 'candidate' : 'reference')
            if (request.runtimeSubset)
              expect(request.runtimeSubset.scopeChecksum).toMatch(/^[a-f0-9]{64}$/u)
            return {
              execute: async ({ sessionRoot, stageRestore }) => {
                expect(stageRestore?.observeRuntimeFootprint).toBe(
                  request.runtimeSubset ? true : undefined
                )
                await writeFile(
                  join(sessionRoot, 'data/de.csv'),
                  candidate && condition === 'file-different' ? 'changed\n' : bytes.de
                )
                return {
                  status: 'completed',
                  stdout: '',
                  stderr: '',
                  traceback: '',
                  stageComparison: {
                    outcome:
                      (candidate && condition === 'state-different') ||
                      (stageRestore?.packageContext &&
                        condition === 'projected-reference-different')
                        ? 'different'
                        : 'equal',
                    ...(stageRestore?.packageContext && condition !== 'projection-missing'
                      ? {
                          scientificOutcome:
                            condition === 'projected-reference-different'
                              ? ('different' as const)
                              : ('equal' as const),
                          packageContext: structuredClone(stageRestore.packageContext)
                        }
                      : {})
                  }
                }
              },
              proposeRuntimeSubset: async () => {
                if (candidate && condition === 'native-unverified') return undefined
                return deriveCondaRuntimeSubsetPlan(
                  original,
                  originalChecksum,
                  request.runtimeSubset!.scopeChecksum,
                  packages.slice(0, 2).map((pkg) => `${pkg.name}-1.0-0.conda`)
                )
              },
              shutdown: async () => {
                sequence.push('reaped')
                if (candidate && ['cancel-during-shutdown', 'cancel-unreaped'].includes(condition))
                  controller.abort(new Error('cancelled during teardown'))
                return { reaped: !['unreaped', 'cancel-unreaped'].includes(condition) }
              }
            }
          }
        }
        const attempt = (): ReturnType<typeof owner> =>
          owner(
            {
              capture: value,
              plan: selected,
              evidence,
              ...(['cancel-during-shutdown', 'cancel-unreaped'].includes(condition)
                ? { signal: controller.signal }
                : {})
            },
            dependencies
          )
        if (mode.startsWith('hint-')) {
          if (['cancel-during-shutdown', 'unreaped', 'cancel-unreaped'].includes(condition)) {
            await expect(attempt()).rejects.toThrow(
              condition === 'unreaped' || condition === 'cancel-unreaped'
                ? 'teardown could not be confirmed'
                : 'cancelled during teardown'
            )
            expect(calls).toBe(1)
            expect(save).not.toHaveBeenCalled()
            expect(restoreCancelled).toHaveBeenCalledTimes(
              condition === 'cancel-during-shutdown' ? 1 : 0
            )
          } else {
            expect((await attempt()).matched).toBe(true)
            if (condition === 'matched') {
              expect(sequence).toEqual(['candidate', 'reaped'])
              expect(save).toHaveBeenCalledTimes(1)
            } else if (
              ['file-different', 'state-different', 'native-unverified'].includes(condition)
            ) {
              expect(sequence).toEqual(['candidate', 'reaped', 'reference', 'reaped'])
              expect(save).not.toHaveBeenCalled()
            } else {
              expect(sequence).toEqual(['reference', 'reaped', 'candidate', 'reaped'])
              expect(save).toHaveBeenCalledTimes(1)
            }
          }
          return
        }
        if (condition === 'projection-missing' || condition === 'projected-reference-different') {
          const result = await attempt()
          expect(result.matched).toBe(true)
          expect(result.comparisons[0]?.stateComparison).not.toHaveProperty('packageContext')
          expect(calls).toBe(2)
        } else if (condition === 'cancel-during-shutdown') {
          await expect(attempt()).rejects.toThrow('cancelled during teardown')
          expect(calls).toBe(2)
          await owner({ capture: value, plan: selected, evidence }, dependencies)
          expect(calls).toBe(4)
        } else if (condition === 'unreaped') {
          await expect(attempt()).rejects.toThrow('teardown could not be confirmed')
          expect(calls).toBe(1)
        } else {
          const expectedMatch = condition === 'matched' || condition === 'projected'
          const result = await attempt()
          // Rejected optimization never invalidates the already verified reference.
          expect(result.matched).toBe(true)
          if (condition === 'projected')
            expect(result.comparisons[0]?.stateComparison).toMatchObject({
              scientificOutcome: 'equal',
              packageContext: {
                sourcePackages: [
                  'DESeq2',
                  'jsonlite',
                  'stats',
                  'graphics',
                  'grDevices',
                  'utils',
                  'datasets',
                  'methods',
                  'base'
                ],
                targetPackages: [
                  'jsonlite',
                  'stats',
                  'graphics',
                  'grDevices',
                  'utils',
                  'datasets',
                  'methods',
                  'base'
                ]
              }
            })
          expect(sequence).toEqual(['reference', 'reaped', 'candidate', 'reaped'])
          await attempt()
          // A matching candidate is reused only for the identical frozen scope.
          expect(calls).toBe(expectedMatch ? 3 : 4)
          if (expectedMatch) {
            const restarted = createWorkflowSliceExecutor({ fileIO, inputPath })
            await restarted({ capture: value, plan: selected, evidence }, dependencies)
            expect(calls).toBe(mode === 'save-io-error' ? 5 : 4)
            expect(sequence.slice(-2)).toEqual(['candidate', 'reaped'])
            if (mode === 'matched') {
              for (const change of ['source', 'input']) {
                const changed = structuredClone(input)
                if (change === 'source') {
                  const run = changed.runs.find(({ runId }) => runId === 'de')!
                  run.script += '\n# changed source'
                  if (run.stageCheckpoint?.state !== 'available') throw new Error('fixture')
                  run.stageCheckpoint.sourceChecksum = sha256(run.script)
                } else {
                  const boundary = changed.graph.entities.find(
                    (entity) => entity.entityId === 'file:clean'
                  )!
                  if (boundary.kind !== 'file-generation') throw new Error('fixture')
                  const differentInput = Buffer.from('different frozen input\n')
                  boundary.checksum = sha256(differentInput)
                  boundary.sizeBytes = differentInput.length
                  boundary.contentStorageKey = 'frozen/changed-clean'
                  await writeFile(join(root, boundary.contentStorageKey), differentInput)
                }
                const capture = sealWorkflowCapture(changed)
                const plan = slices.planWorkflowSlice(capture, {
                  captureId: capture.captureId,
                  targetRunIds: ['de'],
                  independent: true
                })
                const before = calls
                await restarted({ capture, plan, evidence }, dependencies)
                expect(calls - before).toBe(2)
                expect(sequence.slice(-4)).toEqual(['reference', 'reaped', 'candidate', 'reaped'])
              }
            }
            const beforeContextChange = calls
            await owner(
              { capture: value, plan: selected, evidence },
              { ...dependencies, runtimeSubsetContextChecksum: 'b'.repeat(64) }
            )
            expect(calls).toBe(beforeContextChange + 2)
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
  it('blocks an explicit independent request when its captured input state is unavailable', () => {
    const value = capture()
    const selected = slices.planWorkflowSlice(value, {
      captureId: value.captureId,
      targetRunIds: ['de'],
      independent: true
    })
    expect(selected.status).toBe('blocked')
    expect(selected.reasonCodes).toContain('stage-checkpoint-unavailable')
  })
  it('selects exactly the requested run and freezes its original files without rerunning producers', () => {
    const value = sealWorkflowCapture(rDraft())
    const selected = plan(value, ['de'])
    expect(selected.status).toBe('ready')
    expect(selected.selectedStepIds).toEqual(['step:de'])
    expect(selected.crossingFiles.map((file) => file.entityId)).toEqual(['file:clean'])
    expect(selected.stageRestoreRunIds).toEqual(['de'])
    expect(selected.stateComparisonRunIds).toEqual(['de'])
    expect(selected.verification).toBe('state-comparison')
  })

  it('restores only the entry of a continuous selection, and each entry of disjoint selections', () => {
    const value = sealWorkflowCapture(rDraft())
    expect(plan(value, ['de', 'plot']).stageRestoreRunIds).toEqual(['de'])
    expect(plan(value, ['clean', 'plot']).stageRestoreRunIds).toEqual(['clean', 'plot'])
    expect(plan(value, ['de', 'plot']).selectedStepIds).toEqual(['step:de', 'step:plot'])
  })

  it('supplements missing roots in adjacent branches without replacing live results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-stage-supplement-'))
    try {
      const input = rDraft()
      const second = input.runs[1]!.stageCheckpoint!
      if (second.state !== 'available') throw new Error('fixture')
      second.inputNames = ['dds', 'extra']
      second.outputNames = ['next']
      input.graph.edges = input.graph.edges.filter(
        (edge) => edge.activityId !== 'clean' || edge.kind !== 'generated'
      )
      const value = sealWorkflowCapture(input)
      const selected = plan(value, ['setup', 'clean'])
      expect(selected.status).toBe('ready')
      expect(selected.stageRestoreRunIds).toEqual(['setup'])
      expect(selected.stageSupplementNames).toEqual({ clean: ['extra'] })
      const calls: Parameters<NotebookReproductionRuntime['execute']>[0][] = []
      const result = await executeWorkflowSlice(
        { capture: value, plan: selected, evidence: await rEvidenceAt(root) },
        {
          createRuntime: async () => ({
            execute: async (request) => {
              calls.push(request)
              return {
                status: 'completed',
                stdout: '',
                stderr: '',
                traceback: '',
                stageComparison: { outcome: 'equal' }
              }
            },
            shutdown: async () => ({ reaped: true })
          })
        }
      )
      expect(result).toMatchObject({
        matched: true,
        completedStepIds: ['step:setup', 'step:clean']
      })
      expect(calls[0]!.stageRestore).toBeDefined()
      expect(calls[1]!.stageRestore).toBeUndefined()
      expect(calls[1]!.stageSupplement?.names).toEqual(['extra'])
      expect(
        await readFile(calls[1]!.stageSupplement!.inputPath).catch(() => undefined)
      ).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['source', 'epoch', 'environment', 'run', 'path'])(
    'refuses to seal a checkpoint transplanted from another %s',
    (change) => {
      const input = rDraft()
      const checkpoint = input.runs[2]!.stageCheckpoint!
      if (checkpoint.state !== 'available') throw new Error('fixture')
      if (change === 'source') checkpoint.sourceChecksum = sha256('other code')
      if (change === 'epoch') checkpoint.kernelEpochId = 'other-epoch'
      if (change === 'environment') checkpoint.environmentLockChecksum = sha256('other lock')
      if (change === 'run') checkpoint.runId = 'other-run'
      if (change === 'path') checkpoint.input.storageKey = '../foreign.rds'
      expect(() => sealWorkflowCapture(input)).toThrow('Invalid Workflow')
    }
  )

  it('does not suppress missing file evidence when memory is checkpointed', () => {
    const input = rDraft()
    input.graph.completeness = 'incomplete'
    input.graph.reasonCodes = ['file-reads-unavailable']
    input.activityReasonCodes = Object.fromEntries(
      input.runs.map((run) => [run.runId, run.runId === 'de' ? ['file-reads-unavailable'] : []])
    )
    expect(plan(sealWorkflowCapture(input), ['de']).reasonCodes).toContain('file-reads-unavailable')
  })

  it.each(['equal', 'different', 'unavailable', 'corrupt'] as const)(
    'checks state output and never falls back to upstream execution: %s',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'r-stage-slice-'))
      try {
        const value = sealWorkflowCapture(rDraft())
        const selected = plan(value, ['setup'])
        const evidence = await rEvidenceAt(root)
        const execute = vi.fn(
          async (input: Parameters<NotebookReproductionRuntime['execute']>[0]) => {
            expect(input.source).toBe(value.runs[0]!.script)
            expect(await readFile(input.stageRestore!.inputPath)).toEqual(stateBytes)
            return {
              status: 'completed' as const,
              stdout: '',
              stderr: '',
              traceback: '',
              stageComparison: { outcome: outcome === 'corrupt' ? ('equal' as const) : outcome }
            }
          }
        )
        const createRuntime = vi.fn(async () => ({
          execute,
          shutdown: async () => ({ reaped: true })
        }))
        if (outcome === 'corrupt') await writeFile(join(root, stateKey), 'broken state')
        const result = executeWorkflowSlice(
          { capture: value, plan: selected, evidence },
          { createRuntime }
        )
        if (outcome === 'corrupt' || outcome === 'unavailable') {
          await expect(result).rejects.toThrow(
            outcome === 'corrupt' ? 'checkpoint' : 'comparison unavailable'
          )
          if (outcome === 'corrupt') expect(createRuntime).not.toHaveBeenCalled()
        } else {
          expect(await result).toMatchObject({
            verification: 'state-comparison',
            matched: outcome === 'equal',
            completedStepIds: ['step:setup'],
            executionOnlyTargetRunIds: [],
            comparisons: [{ stateComparison: { outcome } }]
          })
        }
        expect(execute).toHaveBeenCalledTimes(outcome === 'corrupt' ? 0 : 1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('complete Workflow capture and run-level slices', () => {
  it('scopes missing helper evidence to selected runs and their necessary ancestors', () => {
    const input = draft()
    input.runs = input.runs.map((run) => ({
      ...run,
      helperEvidenceStatus:
        run.runId === 'sibling'
          ? { state: 'incomplete', reasons: ['source-missing'] }
          : { state: 'complete' }
    }))
    input.helperEvidenceStatus = { state: 'incomplete', reasons: ['source-missing'] }
    expect(plan(sealWorkflowCapture(input), ['clean']).status).toBe('ready')
    expect(plan(sealWorkflowCapture(input), ['sibling']).reasonCodes).toContain(
      'helper-source-incomplete'
    )
    input.runs[0]!.helperEvidenceStatus = { state: 'incomplete', reasons: ['source-missing'] }
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean']).reasonCodes).toContain(
      'helper-source-incomplete'
    )
    for (const run of input.runs) delete run.helperEvidenceStatus
    expect(plan(sealWorkflowCapture(input), ['clean']).reasonCodes).toContain(
      'helper-source-incomplete'
    )
  })

  it.each(['missing run status', 'hidden aggregate failure', 'unknown reason'])(
    'rejects incomplete helper scoping that could hide missing source: %s',
    (condition) => {
      const input = draft()
      input.runs = input.runs.map((run) => ({
        ...run,
        helperEvidenceStatus: { state: 'complete' }
      }))
      input.runs[4]!.helperEvidenceStatus = { state: 'incomplete', reasons: ['source-missing'] }
      input.helperEvidenceStatus = { state: 'incomplete', reasons: ['source-missing'] }
      expect(validWorkflowCapture(sealWorkflowCapture(input))).toBe(true)
      if (condition === 'missing run status') delete input.runs[0]!.helperEvidenceStatus
      if (condition === 'hidden aggregate failure')
        input.runs[4]!.helperEvidenceStatus = { state: 'complete' }
      if (condition === 'unknown reason')
        input.runs[4]!.helperEvidenceStatus = { state: 'incomplete', reasons: ['future' as never] }
      expect(() => sealWorkflowCapture(input)).toThrow('Invalid Workflow')
    }
  )

  it('still blocks a missing keyed helper even with complete per-run status', () => {
    const input = draft()
    input.runs = input.runs.map((run) => ({ ...run, helperEvidenceStatus: { state: 'complete' } }))
    input.runs[1]!.helperModuleKeys = ['missing-key']
    expect(plan(sealWorkflowCapture(input), ['clean']).reasonCodes).toContain(
      'helper-source-incomplete'
    )
  })

  it('normalizes plain cross-realm host records and omitted optional fields to persisted JSON', () => {
    const input = draft()
    input.helperModules = undefined
    const foreign = runInNewContext('JSON.parse(serialized)', {
      serialized: JSON.stringify(input)
    })
    expect(sealWorkflowCapture(foreign)).toEqual(sealWorkflowCapture(input))
    const sealed = sealWorkflowCapture(input)
    expect(Object.hasOwn(sealed, 'helperModules')).toBe(false)
    expect(
      validWorkflowCapture(
        runInNewContext('JSON.parse(serialized)', { serialized: JSON.stringify(sealed) })
      )
    ).toBe(true)
    for (const invalid of [new Date(), () => 1, Object.create({ custom: true })]) {
      expect(() => sealWorkflowCapture({ ...input, truncation: invalid } as never)).toThrow(
        'Invalid Workflow'
      )
    }
  })

  it('binds capture and plan hashes to the actual source, graph, inputs and endpoints', () => {
    const value = capture()
    expect(validWorkflowCapture(value)).toBe(true)
    const selected = plan(value, ['de'], ['file:clean'])
    expect(slices.workflowPlanMatchesCapture(value, selected)).toBe(true)
    selected.steps[0]!.sourceChecksum = '0'.repeat(64)
    expect(slices.workflowPlanMatchesCapture(value, selected)).toBe(false)
    value.runs[0]!.script += '\n# changed'
    expect(validWorkflowCapture(value)).toBe(false)
  })

  it('rejects an Artifact target-closure graph masquerading as a full Workflow capture', () => {
    const input = draft()
    input.graph.activities[0]!.inclusion = 'target-closure'
    expect(() => sealWorkflowCapture(input)).toThrow('Invalid Workflow')
    const omitted = draft()
    omitted.runs.shift()
    expect(() => sealWorkflowCapture(omitted)).toThrow('Invalid Workflow')
  })

  it('selects only the original ancestor code and registered inputs for an intermediate endpoint', () => {
    const value = capture()
    const selected = plan(value, ['de'])
    expect(selected.status).toBe('ready')
    expect(selected.selectedStepIds).toEqual(['step:setup', 'step:clean', 'step:de'])
    expect(selected.crossingFiles.map((file) => file.entityId)).toEqual(['input:raw'])
    expect(selected.targetOutputEntityIds).toEqual(['file:de'])
    expect(selected.environmentRequirements).toHaveLength(1)
    expect(selected.steps.map((step) => step.sourceChecksum)).toEqual(
      value.runs.slice(0, 3).map((run) => sha256(run.script))
    )
    expect(selected.selectedStepIds).not.toContain('step:plot')
    expect(selected.selectedStepIds).not.toContain('step:sibling')
  })

  it('cuts only a file edge while retaining an earlier memory/package ancestor', () => {
    const value = capture()
    const selected = plan(value, ['de'], ['file:clean'])
    expect(selected.status).toBe('ready')
    expect(selected.selectedStepIds).toEqual(['step:setup', 'step:de'])
    expect(selected.crossingFiles.map((file) => file.entityId)).toEqual(['file:clean'])
  })

  it('supports continuous target stages and arbitrary parallel endpoints without intervening runs', () => {
    const value = capture()
    expect(plan(value, ['de', 'plot'], ['file:clean']).selectedStepIds).toEqual([
      'step:setup',
      'step:de',
      'step:plot'
    ])
    expect(plan(value, ['plot', 'sibling'], ['file:de', 'file:clean']).selectedStepIds).toEqual([
      'step:plot',
      'step:sibling'
    ])
  })

  it('localizes partial evidence to selected runs only when complete per-run barriers were captured', () => {
    const input = draft()
    input.graph.completeness = 'incomplete'
    input.graph.reasonCodes = ['activity-evidence-partial']
    input.graph.activities.find((activity) => activity.activityId === 'sibling')!.evidenceState =
      'partial'
    input.activityReasonCodes = Object.fromEntries(
      input.runs.map((run) => [
        run.runId,
        run.runId === 'sibling' ? ['activity-evidence-partial'] : []
      ])
    )
    const value = sealWorkflowCapture(input)
    expect(plan(value, ['de'], ['file:clean']).status).toBe('ready')
    expect(plan(value, ['sibling'], ['file:clean']).status).toBe('blocked')
    delete input.activityReasonCodes
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean']).status).toBe('blocked')
    input.activityReasonCodes = { de: [] }
    expect(() => sealWorkflowCapture(input)).toThrow('Invalid Workflow')
  })

  it.each(['empty map', 'unknown graph reason', 'unknown local reason', 'unreported local reason'])(
    'rejects a reason map that can hide an aggregate barrier: %s',
    (condition) => {
      const input = draft()
      input.graph.completeness = 'incomplete'
      input.graph.reasonCodes = ['kernel-dependencies-unavailable']
      // File evidence can be available while the independent kernel projection is not.
      input.activityReasonCodes = Object.fromEntries(
        input.runs.map((run) => [
          run.runId,
          run.runId === 'de' ? ['kernel-dependencies-unavailable'] : []
        ])
      )
      const original = sealWorkflowCapture(input)
      expect(plan(original, ['de'], ['file:clean']).status).toBe('blocked')
      if (condition === 'empty map') input.activityReasonCodes.de = []
      if (condition === 'unknown graph reason')
        input.graph.reasonCodes.push('future-unknown-reason' as never)
      if (condition === 'unknown local reason')
        input.activityReasonCodes.de.push('future-unknown-reason' as never)
      if (condition === 'unreported local reason')
        input.activityReasonCodes.de.push('writer-attribution-unavailable')
      expect(() => sealWorkflowCapture(input)).toThrow('Invalid Workflow')
    }
  )

  it('keeps capture-wide barriers global even when every local reason list is empty', () => {
    const input = draft()
    input.graph.completeness = 'incomplete'
    input.graph.reasonCodes = ['history-truncated']
    input.activityReasonCodes = Object.fromEntries(input.runs.map((run) => [run.runId, []]))
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean']).status).toBe('blocked')
    input.graph.reasonCodes = []
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean']).status).toBe('blocked')
  })

  it('rejects omitted or conflicting registered input identities in a purported full capture', () => {
    const missing = draft()
    missing.runs[1]!.inputFileVersionKeys.push({
      sourceKind: 'upload-version',
      inputFileVersionId: 'missing'
    })
    expect(() => sealWorkflowCapture(missing)).toThrow('Invalid Workflow')
    const changed = draft()
    changed.inputFiles[0]!.checksum = '0'.repeat(64)
    expect(() => sealWorkflowCapture(changed)).toThrow('Invalid Workflow')
  })

  it('blocks original environment transitions within a selected memory epoch', () => {
    const input = draft()
    input.runs[0]!.environmentLock = {
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: '0'.repeat(64)
    }
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean']).reasonCodes).toContain(
      'environment-transition'
    )
  })

  it.each([
    'unknown target',
    'duplicate target',
    'unknown boundary',
    'unused boundary',
    'different capture',
    'partial evidence',
    'advisory dependency',
    'partial lock'
  ])('blocks %s without widening the selection', (condition) => {
    const input = draft()
    if (condition === 'partial evidence') input.graph.completeness = 'incomplete'
    if (condition === 'advisory dependency')
      input.graph.edges.find(
        (edge) => edge.kind === 'used' && edge.activityId === 'de'
      )!.authority = 'advisory'
    if (condition === 'partial lock')
      input.runs[2]!.environmentLock = {
        state: 'unavailable',
        reason: 'environment-lock-capture-failed'
      }
    const value = sealWorkflowCapture(input)
    const selected = slices.planWorkflowSlice(value, {
      captureId: condition === 'different capture' ? '0'.repeat(64) : value.captureId,
      targetRunIds:
        condition === 'unknown target'
          ? ['missing']
          : condition === 'duplicate target'
            ? ['de', 'de']
            : ['de'],
      boundaryEntityIds:
        condition === 'unknown boundary'
          ? ['missing']
          : condition === 'unused boundary'
            ? ['file:plot']
            : ['file:clean']
    })
    expect(selected.status).toBe('blocked')
    expect(selected.reasonCodes.length).toBeGreaterThan(0)
    expect(selected.selectedStepIds).not.toContain('step:sibling')
  })

  it('allows a selected consumer to read a frozen generation then replace its workspace copy', () => {
    const selected = plan(sealWorkflowCapture(inPlaceDraft()), ['de'], ['file:clean'])
    expect(selected).toMatchObject({
      status: 'ready',
      reasonCodes: [],
      selectedStepIds: ['step:de'],
      targetOutputEntityIds: ['file:de'],
      crossingFiles: [{ entityId: 'file:clean', materializationPath: 'data/clean.csv' }]
    })
    expect(selected.steps[0]).toMatchObject({
      inputEntityIds: ['file:clean'],
      outputEntityIds: ['file:de']
    })
  })

  it('allows an explicitly selected producer to reestablish the exact frozen generation', () => {
    const selected = plan(sealWorkflowCapture(inPlaceDraft()), ['clean', 'de'], ['file:clean'])
    expect(selected.status).toBe('ready')
    expect(selected.selectedStepIds).toEqual(['step:clean', 'step:de'])
    expect(selected.crossingFiles.map((file) => file.entityId)).toEqual(['file:clean', 'input:raw'])
  })

  it('follows consecutive same-path generations in step order rather than graph edge order', () => {
    const input = inPlaceDraft()
    input.graph.edges.reverse()
    const selected = plan(sealWorkflowCapture(input), ['plot'], ['file:clean'])
    expect(selected.status).toBe('ready')
    expect(selected.selectedStepIds).toEqual(['step:de', 'step:plot'])
    expect(selected.steps.map((step) => [step.inputEntityIds, step.outputEntityIds])).toEqual([
      [['file:clean'], ['file:de']],
      [['file:de'], ['file:plot']]
    ])
  })

  it('blocks a later consumer that still needs the frozen generation after an in-place write', () => {
    expect(
      plan(sealWorkflowCapture(inPlaceDraft()), ['de', 'sibling'], ['file:clean'])
    ).toMatchObject({
      status: 'blocked',
      reasonCodes: ['materialization-path-conflict'],
      selectedStepIds: ['step:de', 'step:sibling']
    })
  })

  it('blocks an in-place read whose generation is not available before the selected step', () => {
    const input = inPlaceDraft()
    input.graph.edges.push({
      kind: 'used',
      activityId: 'de',
      entityId: 'file:de',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    })
    const selected = plan(sealWorkflowCapture(input), ['de'], ['file:clean'])
    expect(selected.status).toBe('blocked')
    expect(selected.reasonCodes).toContain('materialization-path-conflict')
  })

  it('blocks multiple same-path output generations within a step with no internal order', () => {
    const input = inPlaceDraft()
    input.graph.edges.push({
      kind: 'generated',
      activityId: 'de',
      entityId: 'file:plot',
      authority: 'advisory',
      evidenceSource: 'runtime-observation'
    })
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean'])).toMatchObject({
      status: 'blocked',
      reasonCodes: ['materialization-path-conflict']
    })
  })

  it('blocks the frozen generation replaced by a different same-checksum memory ancestor generation', () => {
    const input = draft()
    input.graph.entities.push({ ...file('clean'), entityId: 'file:old', generationId: 'old' })
    input.graph.edges.push({
      kind: 'generated',
      activityId: 'setup',
      entityId: 'file:old',
      authority: 'advisory',
      evidenceSource: 'runtime-observation'
    })
    expect(plan(sealWorkflowCapture(input), ['de'], ['file:clean'])).toMatchObject({
      status: 'blocked',
      reasonCodes: ['materialization-path-conflict']
    })
  })

  it('blocks two crossing generations at the same destination even with identical content', () => {
    const input = draft()
    input.graph.entities.push({
      ...file('clean'),
      entityId: 'file:another',
      generationId: 'another'
    })
    input.graph.edges.push({
      kind: 'used',
      activityId: 'de',
      entityId: 'file:another',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    })
    expect(
      plan(sealWorkflowCapture(input), ['de'], ['file:clean', 'file:another']).reasonCodes
    ).toContain('materialization-path-conflict')
  })

  it('does not promote a no-file target to matched through another target or ancestor output', () => {
    const value = capture()
    expect(plan(value, ['setup'])).toMatchObject({
      verification: 'execution-only',
      executionOnlyTargetRunIds: ['setup'],
      targetOutputEntityIds: []
    })
    expect(plan(value, ['setup', 'de'], ['file:clean'])).toMatchObject({
      verification: 'execution-only',
      executionOnlyTargetRunIds: ['setup'],
      targetOutputEntityIds: ['file:de']
    })
  })
})

describe('Workflow slices use the real shared execution pipeline', () => {
  it('compares each in-place generation and preserves the immutable frozen source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-slice-in-place-'))
    const attempt = join(root, 'attempt')
    try {
      const value = sealWorkflowCapture(inPlaceDraft())
      const selected = plan(value, ['plot'], ['file:clean'])
      const evidence = await evidenceAt(root)
      const executed: string[] = []
      const result = await executeWorkflowSlice(
        { capture: value, plan: selected, evidence },
        {
          createAttemptRoot: async () => attempt,
          createRuntime: async () => ({
            execute: async ({ step, source, sessionRoot }) => {
              executed.push(step.runId)
              expect(source).toBe(value.runs.find((run) => run.runId === step.runId)!.script)
              const path = join(sessionRoot, 'data/clean.csv')
              expect(await readFile(path)).toEqual(step.runId === 'de' ? bytes.clean : bytes.de)
              await writeFile(path, step.runId === 'de' ? bytes.de : bytes.plot)
              return { status: 'completed', stdout: '', stderr: '', traceback: '' }
            },
            shutdown: async () => ({ reaped: true })
          })
        }
      )
      expect(executed).toEqual(['de', 'plot'])
      expect(result.matched).toBe(true)
      expect(result.comparisons).toMatchObject([
        { entityId: 'file:de', relativePath: 'data/clean.csv', status: 'matched' },
        { entityId: 'file:plot', relativePath: 'data/clean.csv', status: 'matched' }
      ])
      expect(await readFile(join(root, 'frozen/clean'))).toEqual(bytes.clean)
      await expect(access(attempt)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks physical input space before admitting a runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-slice-space-'))
    try {
      const value = capture()
      const evidence = await evidenceAt(root)
      const disk = await statfs(tmpdir())
      vi.mocked(statfs).mockResolvedValueOnce({ ...disk, bavail: 0 } as never)
      const createRuntime = vi.fn()
      await expect(
        executeWorkflowSlice(
          { capture: value, plan: plan(value, ['de'], ['file:clean']), evidence },
          { createRuntime }
        )
      ).rejects.toThrow('insufficient disk space')
      expect(createRuntime).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects explicitly unrestorable original RNG state before admitting a runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-slice-rng-'))
    try {
      const input = draft()
      const observation = { locale: 'C', timezone: 'UTC', threadLimits: {}, randomLibraries: [] }
      input.runs[2]!.executionContext = {
        schemaVersion: 1,
        before: {
          ...observation,
          pythonRandomState: { state: 'unavailable', reason: 'modified-rng' }
        },
        after: observation
      }
      const value = sealWorkflowCapture(input)
      const createRuntime = vi.fn()
      await expect(
        executeWorkflowSlice(
          {
            capture: value,
            plan: plan(value, ['de'], ['file:clean']),
            evidence: await evidenceAt(root)
          },
          { createRuntime }
        )
      ).rejects.toThrow('modified-rng')
      expect(createRuntime).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('materializes an actual frozen boundary and executes only unchanged selected sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-slice-'))
    const attempt = join(root, 'attempt')
    try {
      const value = capture()
      const selected = plan(value, ['de'], ['file:clean'])
      const evidence = await evidenceAt(root)
      // Original raw input is unnecessary for this selected boundary.
      await rm(join(root, 'uploads/raw'))
      const execute = vi.fn<NotebookReproductionRuntime['execute']>(
        async ({ step, source, sessionRoot }) => {
          expect(source).toBe(value.runs.find((run) => run.runId === step.runId)!.script)
          if (step.runId === 'de') {
            expect(await readFile(join(sessionRoot, 'data/clean.csv'))).toEqual(bytes.clean)
            await writeFile(join(sessionRoot, 'data/de.csv'), bytes.de)
          } else if (step.runId !== 'setup') throw new Error('Unselected source executed')
          return { status: 'completed', stdout: '', stderr: '', traceback: '' }
        }
      )
      const shutdown = vi.fn(async () => ({ reaped: true }))
      const result = await executeWorkflowSlice(
        { capture: value, plan: selected, evidence },
        {
          createAttemptRoot: async () => attempt,
          createRuntime: async ({ selectedRuns }) => {
            expect(selectedRuns!.map(({ source }) => source)).toEqual([
              value.runs[0]!.script,
              value.runs[2]!.script
            ])
            return { execute, shutdown }
          }
        }
      )
      expect(execute.mock.calls.map(([input]) => input.step.runId)).toEqual(['setup', 'de'])
      expect(result).toMatchObject({
        verification: 'file-comparison',
        matched: true,
        captureId: value.captureId,
        planId: selected.planId,
        completedStepIds: ['step:setup', 'step:de']
      })
      expect(shutdown).toHaveBeenCalledOnce()
      await expect(access(attempt)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['corrupt input', 'changed plan', 'failed step'])(
    'rejects %s without a fallback and removes any admitted attempt',
    async (condition) => {
      const root = await mkdtemp(join(tmpdir(), 'workflow-slice-failure-'))
      const attempt = join(root, 'attempt')
      try {
        const value = capture()
        const selected = plan(value, ['de'], ['file:clean'])
        const evidence = await evidenceAt(root)
        if (condition === 'corrupt input') await writeFile(join(root, 'frozen/clean'), 'wrong!')
        if (condition === 'changed plan') selected.steps[0]!.sourceChecksum = '0'.repeat(64)
        const createRuntime = vi.fn(async () => ({
          execute: async () => ({
            status: 'failed' as const,
            stdout: '',
            stderr: 'original step failed',
            traceback: ''
          }),
          shutdown: async () => ({ reaped: true })
        }))
        await expect(
          executeWorkflowSlice(
            { capture: value, plan: selected, evidence },
            {
              createAttemptRoot: async () => attempt,
              createRuntime
            }
          )
        ).rejects.toThrow()
        if (condition !== 'failed step') expect(createRuntime).not.toHaveBeenCalled()
        await expect(access(attempt)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('reports execution-only without a matched field for a target with no persistent outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-slice-no-output-'))
    try {
      const value = capture()
      const selected = plan(value, ['setup'])
      const result = await executeWorkflowSlice(
        { capture: value, plan: selected, evidence: await evidenceAt(root) },
        {
          createRuntime: async () => ({
            execute: async () => ({ status: 'completed', stdout: '42', stderr: '', traceback: '' }),
            shutdown: async () => ({ reaped: true })
          })
        }
      )
      expect(result).toMatchObject({
        verification: 'execution-only',
        executionOnlyTargetRunIds: ['setup'],
        comparisons: []
      })
      expect(result).not.toHaveProperty('matched')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
