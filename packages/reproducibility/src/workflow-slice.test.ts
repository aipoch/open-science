import { mkdir, mkdtemp, readFile, rm, writeFile, access, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createWorkflowSlices, sealWorkflowCapture, validWorkflowCapture } from './workflow-slice'
import { createWorkflowSliceExecutor } from './execution'
import { sha256 } from './canonical'
import { fileIO, reproductionEvidence } from './test-support'
import type { NotebookReproductionRuntime, ReproductionEvidence } from './ports'
import type {
  ArtifactProvenanceGraphEntity,
  ProvenanceNotebookRun,
  WorkflowCapture,
  WorkflowPlan
} from './evidence'
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, statfs: vi.fn(fs.statfs) }
})

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

  it.each(['python', 'r'] as const)(
    'replays the original %s ancestors without variable snapshots for an intermediate endpoint',
    (kernelKind) => {
      const source = draft()
      for (const run of source.runs) run.kernelKind = kernelKind
      const value = sealWorkflowCapture(source)
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
    }
  )

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
          createRuntime: async () => ({ execute, shutdown })
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
