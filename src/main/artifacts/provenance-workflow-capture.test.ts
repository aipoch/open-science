import { describe, expect, it } from 'vitest'
import { sealWorkflowCapture, validWorkflowCapture } from '@aipoch/reproducibility'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import type { ExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import {
  sealArtifactProvenanceGraph,
  type SealArtifactProvenanceGraphInput
} from './artifact-provenance-graph'
import {
  buildBoundedExecutionSnapshot,
  captureArtifactWorkflow,
  decodeArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { reproductionWorkflowSlices } from './reproducibility-host'
import {
  MAX_EXTENDED_EXECUTION_SNAPSHOT_BYTES,
  MAX_WORKFLOW_CAPTURE_BYTES
} from './provenance-workflow-capture'

const inputFile: NotebookRunInputFile = {
  sourceKind: 'upload-version',
  inputFileVersionId: 'input-v1',
  sourceFileId: 'input',
  sourceProjectId: 'project',
  sourceSessionId: 'session',
  filename: 'counts.csv',
  checksum: 'c'.repeat(64),
  sizeBytes: 1,
  storageKey: 'uploads/input-v1',
  association: 'turn-attached'
}

const fixture = (
  script = 'x <- 1'
): {
  input: SealArtifactProvenanceGraphInput
  eligibleRuns: Array<{ run: NotebookRunRecord; runIndex: number }>
} => {
  const notebookActivities = ['setup', 'side', 'producer'].map((runId, runIndex) => {
    const path = runId === 'side' ? 'qc.png' : 'volcano.png'
    const digest = (runId === 'side' ? 'a' : 'b').repeat(64)
    const relations =
      runIndex === 0
        ? []
        : [
            {
              relation: 'created',
              relativePath: path,
              pathPortability: 'relative',
              authority: 'advisory',
              generation: {
                generationId: `generation-${runId}`,
                relativePath: path,
                checksum: digest,
                sizeBytes: 1,
                contentStorageKey: `execution-file-evidence/blobs/sha256-${digest}`,
                capturedAt: '2026-10-20T00:00:00.000Z'
              }
            }
          ]
    const json = JSON.stringify({
      schemaVersion: 1,
      evidenceId: `evidence-${runId}`,
      activityId: runId,
      activityKind: 'notebook-run',
      state: 'available',
      observedRoots: ['data'],
      initialViewState: 'complete',
      managedRootsFinalState: 'complete',
      fileReads: 'complete',
      externalPaths: 'complete',
      writerAttribution: 'complete',
      reasonCodes: [],
      scientificOutputs: [],
      relations
    })
    const fileEvidence: ExecutionFileEvidenceSummary = {
      schemaVersion: 1,
      activityId: runId,
      activityKind: 'notebook-run',
      state: 'available',
      evidenceId: `evidence-${runId}`,
      checksum: sha256(json),
      storageKey: `execution-file-evidence/${runId}/evidence.json`,
      relationCount: relations.length,
      generationCount: relations.length,
      scientificOutputCount: 0,
      initialViewState: 'complete',
      managedRootsFinalState: 'complete',
      scientificOutputAnalysis: 'complete',
      fileReads: 'complete',
      externalPaths: 'complete',
      writerAttribution: 'complete',
      reasonCodes: []
    }
    const run: NotebookRunRecord = {
      runId,
      cellId: runId,
      source: 'agent',
      agentFrameId: 'frame',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt',
      kernelEpochId: 'epoch',
      kernelDispatched: true,
      kernelKind: 'r',
      script: runIndex === 0 ? script : 'graphics::plot.default(1, 1)',
      status: 'completed',
      startedAt: runIndex,
      endedAt: runIndex + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: runIndex === 0 ? [inputFile] : [],
      fileEvidence
    }
    return { run, runIndex, evidenceJson: json }
  })
  return {
    input: {
      target: {
        versionId: 'version',
        filename: 'volcano.png',
        checksum: 'b'.repeat(64),
        sizeBytes: 1,
        producerRunId: 'producer',
        sourceGenerationId: 'generation-producer'
      },
      notebookActivities,
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: {
          setup: { state: 'clear' },
          side: { state: 'clear' },
          producer: { state: 'clear' }
        },
        invalidatedByRunId: {},
        dependenciesByRunId: { setup: [], side: [], producer: [] },
        executionDependenciesByRunId: { setup: [], side: [], producer: [] }
      }
    },
    eligibleRuns: notebookActivities.map(({ run, runIndex }) => ({ run, runIndex }))
  }
}

const snapshot = (source: ReturnType<typeof fixture>): PersistedArtifactExecutionSnapshot =>
  buildBoundedExecutionSnapshot(
    {
      schemaVersion: 2,
      rootFrameId: 'root',
      agentFrameId: 'frame',
      messageBranchId: 'branch',
      terminalPromptMessageId: 'prompt',
      producerRunId: 'producer',
      producerRunIndex: 2,
      createdAt: '2026-10-20T00:00:00.000Z',
      provenanceGraph: sealArtifactProvenanceGraph(source.input),
      workflowCapture: captureArtifactWorkflow(source.input, source.eligibleRuns)
    },
    source.eligibleRuns
  )

const attachCheckpoint = (run: NotebookRunRecord): void => {
  run.environmentLock = {
    state: 'available',
    format: 'environment-lock-bundle',
    lockChecksum: 'd'.repeat(64)
  }
  const blob = {
    checksum: 'e'.repeat(64),
    sizeBytes: 12,
    storageKey: `runtime/provenance/r-stage-checkpoints/${'e'.repeat(64)}.rds`
  }
  run.stageCheckpoint = {
    state: 'available',
    schemaVersion: 1,
    runId: run.runId,
    kernelEpochId: run.kernelEpochId!,
    sourceChecksum: sha256(run.script),
    environmentLockChecksum: 'd'.repeat(64),
    input: blob,
    output: blob,
    inputNames: ['dds'],
    outputNames: ['result']
  }
}

describe('immutable workflow capture', () => {
  it('seals the original R checkpoint and preserves old runs without inventing evidence', () => {
    const source = fixture()
    attachCheckpoint(source.eligibleRuns[0]!.run)
    const stored = snapshot(source)
    expect(stored.runs[0]!.stageCheckpoint).toEqual(source.eligibleRuns[0]!.run.stageCheckpoint)
    expect(stored.runs[1]!.stageCheckpoint).toBeUndefined()
    expect(stored.workflowCapture?.state).toBe('available')
    if (stored.workflowCapture?.state !== 'available') throw new Error('Expected workflow')
    expect(stored.workflowCapture.capture.runs[0]!.stageCheckpoint).toEqual(
      stored.runs[0]!.stageCheckpoint
    )
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored)).status).toBe('valid')
  })

  it.each(['runId', 'kernelEpochId', 'sourceChecksum', 'environmentLockChecksum'] as const)(
    'rejects an R checkpoint with mismatched %s even after resealing its capture',
    (field) => {
      const source = fixture()
      attachCheckpoint(source.eligibleRuns[0]!.run)
      const stored = snapshot(source)
      const workflow = stored.workflowCapture
      if (workflow?.state !== 'available') throw new Error('Expected workflow')
      const checkpoint = workflow.capture.runs[0]!.stageCheckpoint!
      if (checkpoint.state !== 'available') throw new Error('Expected checkpoint')
      checkpoint[field] = field.endsWith('Checksum') ? 'f'.repeat(64) : 'another-run'
      const { captureId: _captureId, ...draft } = workflow.capture
      void _captureId
      workflow.capture.captureId = sha256(canonicalJson(draft as unknown as CanonicalJson))
      expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored)).status).toBe('corrupt')
      source.eligibleRuns[0]!.run.stageCheckpoint = checkpoint
      expect(captureArtifactWorkflow(source.input, source.eligibleRuns)).toEqual({
        state: 'unavailable',
        reason: 'incomplete-evidence'
      })
    }
  )

  it('keeps exact long checkpoint source in the workflow while marking the display copy unavailable', () => {
    const source = fixture(`# ${'x'.repeat(17000)}\nx <- 1`)
    attachCheckpoint(source.eligibleRuns[0]!.run)
    const stored = snapshot(source)
    expect(stored.runs[0]!.stageCheckpoint).toEqual({
      state: 'unavailable',
      reason: 'source-truncated'
    })
    expect(stored.workflowCapture?.state).toBe('available')
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored)).status).toBe('valid')
  })

  it('retains per-run helper failures without blocking an unrelated captured run', () => {
    const source = fixture()
    for (const { run } of source.eligibleRuns) {
      run.environmentLock = {
        state: 'available',
        format: 'environment-lock-bundle',
        lockChecksum: 'd'.repeat(64)
      }
    }
    source.eligibleRuns[1]!.run.helperEvidenceStatus = {
      state: 'incomplete',
      reasons: ['source-missing']
    }
    const stored = snapshot(source)
    const workflow = stored.workflowCapture
    if (workflow?.state !== 'available') throw new Error('Expected complete workflow')
    expect(workflow.capture.runs.map((run) => run.helperEvidenceStatus)).toEqual([
      { state: 'complete' },
      { state: 'incomplete', reasons: ['source-missing'] },
      { state: 'complete' }
    ])
    const selection = { captureId: workflow.capture.captureId, targetRunIds: ['producer'] }
    expect(reproductionWorkflowSlices.planWorkflowSlice(workflow.capture, selection).status).toBe(
      'ready'
    )
    expect(
      reproductionWorkflowSlices.planWorkflowSlice(workflow.capture, {
        ...selection,
        targetRunIds: ['side']
      }).reasonCodes
    ).toContain('helper-source-incomplete')
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored))).toMatchObject({
      status: 'valid',
      value: { workflowCapture: workflow }
    })
  })

  it('attributes a conflicting helper identity to both runs that supplied it', () => {
    const source = fixture()
    const helper = {
      helperId: 'helper',
      skillIdentity: 'skill',
      packageOrigin: 'package',
      interfaceRevision: '1',
      registeredGeneration: 'generation',
      exports: ['original'],
      source: 'x <- 1',
      sourceDigest: sha256('x <- 1')
    }
    for (const index of [0, 1, 2]) {
      source.eligibleRuns[index]!.run.helperModules = [{ ...helper }]
      source.eligibleRuns[index]!.run.helperEvidenceStatus = { state: 'complete' }
    }
    source.eligibleRuns[1]!.run.helperModules![0]!.exports = ['conflicting']
    const workflow = snapshot(source).workflowCapture
    if (workflow?.state !== 'available') throw new Error('Expected complete workflow')
    expect(workflow.capture.runs.map((run) => run.helperEvidenceStatus)).toEqual([
      { state: 'incomplete', reasons: ['source-corrupt'] },
      { state: 'incomplete', reasons: ['source-corrupt'] },
      { state: 'incomplete', reasons: ['source-corrupt'] }
    ])
  })

  it('retains exact original scripts, unneeded registered inputs and side outputs', () => {
    const script = `# ${'original'.repeat(5000)}\nx <- 1`
    const stored = snapshot(fixture(script))
    expect(stored.inputFiles).toEqual([])
    expect(stored.runs[0]!.scriptTruncated).toBe(true)
    expect(stored.provenanceGraph!.activities).toHaveLength(2)
    const wrapper = stored.workflowCapture
    expect(wrapper?.state).toBe('available')
    if (wrapper?.state !== 'available') throw new Error('Expected complete workflow')
    expect(validWorkflowCapture(wrapper.capture)).toBe(true)
    expect(wrapper.capture.runs[0]!.script).toBe(script)
    expect(wrapper.capture.runs[0]!.scriptTruncated).toBeUndefined()
    expect(wrapper.capture.runs.map((run) => run.runId)).toEqual(['setup', 'side', 'producer'])
    expect(wrapper.capture.inputFiles).toEqual([inputFile])
    expect(wrapper.capture.graph.entities.map((entity) => entity.entityId)).toContain(
      'file-generation:generation-side'
    )
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored))).toMatchObject({
      status: 'valid',
      value: { workflowCapture: wrapper }
    })
  })

  it('does not silently trim large workflow code or evict legacy Artifact evidence', () => {
    const source = fixture(`# ${'x'.repeat(MAX_WORKFLOW_CAPTURE_BYTES)}`)
    const stored = snapshot(source)
    expect(stored.workflowCapture).toEqual({ state: 'unavailable', reason: 'payload-limit' })
    expect(stored.runs.map((run) => run.runId)).toEqual(['setup', 'side', 'producer'])
    expect(stored.truncation).toBeUndefined()
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored)).status).toBe('valid')
  })

  it('preserves the legacy budget independently when the combined snapshot exceeds 4 MiB', () => {
    const source = fixture()
    source.eligibleRuns[0]!.run.outputs = Array.from({ length: 200 }, () => ({
      type: 'text',
      text: 'x'.repeat(14_000)
    }))
    const stored = snapshot(source)
    expect(stored.workflowCapture?.state).toBe('available')
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(4 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(
      MAX_EXTENDED_EXECUTION_SNAPSHOT_BYTES
    )
    expect(stored.runs[0]!.outputs).toHaveLength(200)
    expect(stored.truncation).toBeUndefined()
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(stored)).status).toBe('valid')
  })

  it('refuses incomplete workflow history while retaining the source Artifact snapshot', () => {
    const source = fixture()
    source.input.omittedLeadingActivityCount = 1
    expect(snapshot(source).workflowCapture).toEqual({
      state: 'unavailable',
      reason: 'incomplete-evidence'
    })
  })

  it('records local kernel and file barriers without discarding independent stages', () => {
    const source = fixture()
    delete source.input.notebookDependencies!.dependenciesByRunId!.side
    delete source.input.notebookDependencies!.executionDependenciesByRunId!.side
    source.input.notebookActivities[1]!.evidenceJson = undefined
    const wrapper = snapshot(source).workflowCapture
    expect(wrapper?.state).toBe('available')
    if (wrapper?.state !== 'available') throw new Error('Expected captured workflow with barriers')
    expect(wrapper.capture.graph.completeness).toBe('incomplete')
    expect(wrapper.capture.activityReasonCodes).toMatchObject({
      setup: [],
      producer: [],
      side: expect.arrayContaining([
        'kernel-dependencies-unavailable',
        'activity-evidence-unavailable'
      ])
    })
  })

  it('rejects conflicting immutable input identity across original runs', () => {
    const source = fixture()
    source.eligibleRuns[1]!.run.inputFiles = [{ ...inputFile, checksum: 'd'.repeat(64) }]
    expect(snapshot(source).workflowCapture).toEqual({
      state: 'unavailable',
      reason: 'incomplete-evidence'
    })
  })

  it('rejects mutated payloads, source-anchor changes and reordered runs on read', () => {
    const stored = snapshot(fixture())
    const wrapper = stored.workflowCapture
    if (wrapper?.state !== 'available') throw new Error('Expected complete workflow')
    const mutated = structuredClone(stored)
    if (mutated.workflowCapture?.state !== 'available')
      throw new Error('Expected complete workflow')
    mutated.workflowCapture.capture.runs[0]!.script = 'tampered <- TRUE'
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(mutated)).status).toBe('corrupt')

    const { captureId: _captureId, ...draft } = wrapper.capture
    void _captureId
    const reordered = sealWorkflowCapture({ ...draft, runs: [...draft.runs].reverse() })
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...stored,
          workflowCapture: { state: 'available', capture: reordered }
        })
      ).status
    ).toBe('corrupt')
    const changed = structuredClone(draft)
    const anchor = changed.graph.entities.find((entity) => entity.kind === 'artifact-version')!
    anchor.checksum = 'd'.repeat(64)
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...stored,
          workflowCapture: { state: 'available', capture: sealWorkflowCapture(changed) }
        })
      ).status
    ).toBe('corrupt')
  })

  it.each(['graph', 'analysis'] as const)(
    'keeps original runs readable with a future source %s and an existing workflow',
    (kind) => {
      const stored = snapshot(fixture())
      expect(stored.workflowCapture?.state).toBe('available')
      const changed = {
        ...stored,
        ...(kind === 'graph'
          ? { provenanceGraph: { schemaVersion: 99 } }
          : { analysisRevision: { schemaVersion: 99 } })
      }
      expect(decodeArtifactExecutionSnapshot(JSON.stringify(changed))).toMatchObject({
        status: 'valid',
        value: {
          runs: stored.runs,
          workflowCapture: { state: 'unavailable', reason: 'incomplete-evidence' }
        }
      })
      if (kind === 'graph')
        expect(
          decodeArtifactExecutionSnapshot(
            JSON.stringify({ ...stored, provenanceGraph: { schemaVersion: 1 } })
          ).status
        ).toBe('corrupt')
    }
  )

  it('keeps historical records unchanged and makes future workflow formats unavailable', () => {
    const stored = snapshot(fixture())
    const { workflowCapture: _capture, ...legacy } = stored
    void _capture
    const decodedLegacy = decodeArtifactExecutionSnapshot(JSON.stringify(legacy))
    expect(decodedLegacy.status).toBe('valid')
    if (decodedLegacy.status !== 'valid') throw new Error('Expected legacy snapshot')
    expect(decodedLegacy.value.workflowCapture).toBeUndefined()
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...legacy,
          workflowCapture: { state: 'available', capture: { schemaVersion: 99 } }
        })
      )
    ).toMatchObject({
      status: 'valid',
      value: { workflowCapture: { state: 'unavailable', reason: 'incomplete-evidence' } }
    })
  })

  it('bounds the new outer envelope before JSON parsing', () => {
    expect(
      decodeArtifactExecutionSnapshot(' '.repeat(MAX_EXTENDED_EXECUTION_SNAPSHOT_BYTES + 1))
    ).toEqual({ status: 'corrupt' })
  })
})
