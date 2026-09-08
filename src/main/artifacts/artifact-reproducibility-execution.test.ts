import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm), writeFile: vi.fn(fs.writeFile) }
})
import sharp from 'sharp'
import * as outputFiles from './artifact-reproducibility-outputs'

import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import {
  createNotebookReproductionRuntime,
  type NotebookReproductionRuntime
} from '../notebook/reproduction-runtime'
import { sealArtifactReproducibilityRecipe } from './artifact-reproducibility-recipe'
import {
  executeArtifactReproducibility,
  type ArtifactReproducibilityExecutionEvent
} from './artifact-reproducibility-execution'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

const environmentLock = {
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
        '@EXPLICIT\nhttps://repo.example.test/python-3.12.conda#0123456789abcdef0123456789abcdef\n',
      packages: ['python']
    }
  ]
} as const

const fixture = async (
  root: string,
  kernelKind: 'python' | 'r' = 'python',
  filename = 'result.txt',
  output = Buffer.from('result\n')
): Promise<{
  execution: PersistedArtifactExecutionSnapshot
  inputChecksum: string
  output: Buffer
}> => {
  const input = Buffer.from('source\n')
  const inputChecksum = sha256(input)
  const outputChecksum = sha256(output)
  const environmentName = `default-${kernelKind}`
  const serializedLock = canonicalJson({
    ...environmentLock,
    kernelKind,
    environmentName
  } as unknown as CanonicalJson)
  const lockChecksum = sha256(serializedLock)
  const inputStorageKey = 'uploads/project/input/version/content'
  const lockStorageKey = `runtime/provenance/environment-locks/${lockChecksum}.json`
  for (const [key, content] of [
    [inputStorageKey, input],
    [lockStorageKey, Buffer.from(serializedLock)]
  ] as const) {
    const path = join(root, ...key.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  const run: ProvenanceNotebookRun = {
    runId: 'run-1',
    runIndex: 0,
    agentFrameId: 'frame-1',
    messageBranchId: 'branch-1',
    runtimeSegmentId: 'segment-1',
    promptMessageId: 'prompt-1',
    kernelKind,
    environmentName,
    environmentLock: {
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum
    },
    script: "open('result.txt', 'w').write('result\\n')",
    status: 'completed',
    startedAt: '2026-09-02T00:00:00.000Z',
    completedAt: '2026-09-02T00:00:01.000Z',
    outputs: [],
    inputFileVersionKeys: []
  }
  const graph: ArtifactProvenanceGraph = {
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
        activityId: 'artifact-publication:version-1',
        kind: 'artifact-publication',
        sequence: 1,
        parentActivityId: 'run-1',
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
        checksum: inputChecksum,
        sizeBytes: input.byteLength
      },
      {
        entityId: 'file-generation:result',
        kind: 'file-generation',
        generationId: 'result',
        relativePath: `data/${filename}`,
        pathPortability: 'relative',
        checksum: outputChecksum,
        sizeBytes: output.byteLength,
        contentStorageKey: `execution-file-evidence/blobs/sha256-${outputChecksum}`
      },
      {
        entityId: 'artifact-version:version-1',
        kind: 'artifact-version',
        versionId: 'version-1',
        filename: 'result.txt',
        checksum: outputChecksum,
        sizeBytes: output.byteLength
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
  }
  const inputFiles: PersistedArtifactExecutionSnapshot['inputFiles'] = [
    {
      inputFileVersionId: 'input-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceProjectId: 'project-1',
      sourceSessionId: 'session-1',
      filename: 'source.csv',
      sizeBytes: input.byteLength,
      checksum: inputChecksum,
      storageKey: inputStorageKey,
      association: 'resolver-accessed'
    }
  ]
  const recipe = sealArtifactReproducibilityRecipe({
    provenanceGraph: graph,
    inputFiles,
    runs: [run]
  })
  const execution: PersistedArtifactExecutionSnapshot = {
    schemaVersion: 2,
    rootFrameId: 'root-frame-1',
    agentFrameId: 'frame-1',
    messageBranchId: 'branch-1',
    terminalPromptMessageId: 'prompt-1',
    producerRunId: 'run-1',
    producerRunIndex: 0,
    createdAt: '2026-09-02T00:00:02.000Z',
    inputFiles,
    runs: [run],
    provenanceGraph: graph,
    reproducibilityRecipe: recipe
  }
  return { execution, inputChecksum, output }
}

const sandbox = { wrap: vi.fn() }
const systemPython =
  process.env.OPEN_SCIENCE_TEST_PYTHON ??
  (process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => join(directory, process.platform === 'win32' ? 'python.exe' : 'python3'))
    .find((candidate) => existsSync(candidate))
const reproductionSmokeEnabled =
  process.env.RUN_REPRODUCTION_SMOKE === '1' &&
  process.platform !== 'win32' &&
  systemPython !== undefined
const systemRscript = process.env.OPEN_SCIENCE_TEST_R_ENV
  ? join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin', 'Rscript')
  : (process.env.PATH ?? '')
      .split(delimiter)
      .map((directory) => join(directory, 'Rscript'))
      .find((candidate) => existsSync(candidate))

describe('Artifact reproducibility execution', () => {
  it.each([
    ['result.rds', 'unsupported-format'],
    ['result.h5ad', 'unsupported-format'],
    ['result.csv', 'budget-exceeded'],
    ['result.csv', 'comparison-failed']
  ] as const)('records why %s content comparison is unavailable: %s', async (filename, reason) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-unavailable-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const readContent = vi.spyOn(outputFiles, 'readReproducibilityOutputFile')
    try {
      const { execution } = await fixture(storageRoot, 'python', filename)
      const runtime: NotebookReproductionRuntime = {
        execute: async ({ sessionRoot }) => {
          const path = join(sessionRoot, 'data', filename)
          await writeFile(path, 'different output\n')
          if (reason === 'budget-exceeded') {
            const { truncate } = await import('node:fs/promises')
            await truncate(path, 32 * 1024 * 1024 + 1)
          }
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: join(sessionRoot, 'data'),
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      }
      // No original blob is available: supported, bounded files must report the read failure.
      const result = await executeArtifactReproducibility(
        { execution, frontierId: 'original-inputs', storageRoot, processSandbox: sandbox },
        { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
      )
      expect(result.matched).toBe(false)
      expect(result.comparisons[0]).toMatchObject({
        status: 'different',
        contentComparisonUnavailableReason: reason
      })
      expect(result.comparisons[0]).not.toHaveProperty('contentComparison')
      if (reason !== 'comparison-failed') expect(readContent).not.toHaveBeenCalled()
    } finally {
      readContent.mockRestore()
      await rm(storageRoot, { recursive: true, force: true })
      await rm(attemptRoot, { recursive: true, force: true })
    }
  })
  it.runIf(process.env.RUN_REPRODUCTION_SMOKE === '1')(
    'requires both real kernels when smoke coverage is requested',
    () => {
      expect(process.platform).not.toBe('win32')
      expect(systemPython && existsSync(systemPython)).toBe(true)
      expect(systemRscript && existsSync(systemRscript)).toBe(true)
    }
  )
  it.each(['csv', 'tif', 'tiff'])(
    'compares decoded %s outputs without replacing the exact byte result',
    async (extension) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-content-'))
      const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-content-attempt-'))
      try {
        const filename = `result.${extension}`
        const expected =
          extension === 'csv'
            ? Buffer.from('result\n')
            : await sharp({
                create: { width: 10, height: 10, channels: 3, background: 'white' }
              })
                .tiff({ compression: 'none' })
                .toBuffer()
        const actual =
          extension === 'csv'
            ? Buffer.from('"result"\r\n')
            : await sharp(expected).tiff({ compression: 'lzw' }).toBuffer()
        const { execution, output } = await fixture(storageRoot, 'python', filename, expected)
        const blobRoot = join(storageRoot, 'execution-file-evidence', 'blobs')
        await mkdir(blobRoot, { recursive: true })
        await writeFile(join(blobRoot, `sha256-${sha256(output)}`), output)
        const runtime: NotebookReproductionRuntime = {
          execute: async ({ sessionRoot }) => {
            await writeFile(join(sessionRoot, 'data', filename), actual)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: join(sessionRoot, 'data'),
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }
        const result = await executeArtifactReproducibility(
          { execution, frontierId: 'original-inputs', storageRoot, processSandbox: sandbox },
          { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
        )
        expect(result.matched).toBe(false)
        expect(result.comparisons[0]).toMatchObject({
          status: 'different',
          contentComparison: {
            kind: extension === 'csv' ? 'table' : 'image',
            outcome: 'equal',
            expectedChecksum: sha256(output),
            actualChecksum: sha256(actual)
          }
        })
      } finally {
        await rm(storageRoot, { recursive: true, force: true })
        await rm(attemptRoot, { recursive: true, force: true })
      }
    }
  )
  it('copies frozen inputs, runs the exact source, compares outputs, and removes the attempt', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const { execution, inputChecksum, output } = await fixture(storageRoot)
    const events: ArtifactReproducibilityExecutionEvent[] = []
    const execute = vi.fn<NotebookReproductionRuntime['execute']>(
      async ({ source, sessionRoot }) => {
        expect(source).toBe(execution.runs[0]!.script)
        expect(
          await readFile(
            join(sessionRoot, 'data', 'inputs', `source-${inputChecksum.slice(0, 12)}.csv`),
            'utf8'
          )
        ).toBe('source\n')
        await writeFile(join(sessionRoot, 'data', 'result.txt'), output)
        return {
          status: 'completed',
          stdout: 'created result.txt\n',
          stderr: 'warning from runtime\n',
          traceback: '',
          cwdAfter: join(sessionRoot, 'data'),
          outputs: []
        }
      }
    )
    const runtime: NotebookReproductionRuntime = {
      execute,
      shutdown: vi.fn(async () => ({ reaped: true }))
    }

    const result = await executeArtifactReproducibility(
      {
        execution,
        frontierId: 'original-inputs',
        storageRoot,
        processSandbox: sandbox,
        onEvent: (event) => events.push(event)
      },
      {
        createAttemptRoot: async () => attemptRoot,
        createRuntime: async (input) => {
          input.onEnvironmentProgress?.({
            requirementId: input.requirements[0]!.requirementId,
            kernelKind: 'python',
            index: 0,
            total: 1,
            stage: 'restoring-packages'
          })
          input.onEnvironmentOutput?.({
            requirementId: input.requirements[0]!.requirementId,
            kernelKind: 'python',
            index: 0,
            total: 1,
            stream: 'stdout',
            text:
              '\u001b[32mLinking numpy\u001b[0m\rDownloading scipy from ' +
              'https://user:password@example.test/channel?token=secret\n'
          })
          return runtime
        }
      }
    )

    expect(result).toMatchObject({
      matched: true,
      completedStepIds: ['step:run-1'],
      comparisons: [{ entityId: 'file-generation:result', status: 'matched' }]
    })
    expect(events[0]).toMatchObject({
      type: 'attempt-started',
      totalEnvironments: 1,
      totalSteps: 1,
      totalComparisons: 1
    })
    expect(events.map(({ type }) => type)).toEqual([
      'attempt-started',
      'inputs-materialized',
      'environment-progress',
      'environment-output',
      'environments-restored',
      'step-started',
      'step-output',
      'step-completed',
      'output-compared',
      'attempt-completed'
    ])
    expect(events.find((event) => event.type === 'environment-output')).toEqual({
      type: 'environment-output',
      entry: {
        source: 'environment',
        requirementId: expect.stringMatching(/^environment-lock:/),
        environmentIndex: 0,
        environmentTotal: 1,
        kernelKind: 'python',
        stream: 'stdout',
        text: 'Linking numpy\nDownloading scipy from https://example.test/channel?token=[redacted]\n'
      }
    })
    expect(JSON.stringify(events)).not.toContain('password')
    expect(JSON.stringify(events)).not.toContain('token=secret')
    expect(events.find((event) => event.type === 'step-output')).toEqual({
      type: 'step-output',
      entries: [
        {
          source: 'notebook',
          stepId: 'step:run-1',
          runIndex: 0,
          kernelKind: 'python',
          stream: 'stdout',
          text: 'created result.txt\n'
        },
        {
          source: 'notebook',
          stepId: 'step:run-1',
          runIndex: 0,
          kernelKind: 'python',
          stream: 'stderr',
          text: 'warning from runtime\n'
        }
      ]
    })
    await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['saved', 'quota', 'unavailable'] as const)(
    'reports a changed file and handles output retention: %s',
    async (retention) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
      const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
      const { execution } = await fixture(storageRoot)
      const runtime: NotebookReproductionRuntime = {
        execute: async ({ sessionRoot }) => {
          await writeFile(join(sessionRoot, 'data', 'result.txt'), 'changed\n')
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: join(sessionRoot, 'data'),
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      }

      const retained: Buffer[] = []
      const result = await executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox,
          retainOutput: async (bytes) => {
            retained.push(bytes)
            await expect(access(attemptRoot)).resolves.toBeUndefined()
            if (retention === 'unavailable') throw new Error('storage offline')
            return retention === 'saved'
          }
        },
        { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
      )

      expect(result.matched).toBe(false)
      expect(retained).toEqual([Buffer.from('changed\n')])
      expect(result.comparisons[0]).toMatchObject(
        retention === 'saved'
          ? { outputCaptured: true, actualChecksum: sha256('changed\n'), actualSizeBytes: 8 }
          : { outputCaptureReason: retention === 'quota' ? 'storage-limit' : 'unavailable' }
      )
      await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(result.comparisons).toEqual([
        expect.objectContaining({ status: 'different', reason: 'size-mismatch' })
      ])
    }
  )

  it('reports a missing output and still removes the disposable attempt', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const { execution } = await fixture(storageRoot)
    const runtime: NotebookReproductionRuntime = {
      execute: async ({ sessionRoot }) => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: join(sessionRoot, 'data'),
        outputs: []
      }),
      shutdown: async () => ({ reaped: true })
    }

    const result = await executeArtifactReproducibility(
      {
        execution,
        frontierId: 'original-inputs',
        storageRoot,
        processSandbox: sandbox
      },
      { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
    )

    expect(result.comparisons).toEqual([
      expect.objectContaining({ status: 'different', reason: 'missing' })
    ])
    await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([false, true])(
    'compares and retains each generation before the same path is overwritten (differs: %s)',
    async (changed) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
      const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
      const { execution } = await fixture(storageRoot)
      const firstOutput = Buffer.from('first\n')
      const finalOutput = Buffer.from('final\n')
      const firstChecksum = sha256(firstOutput)
      const finalChecksum = sha256(finalOutput)
      const firstRun = {
        ...execution.runs[0]!,
        script: "open('result.txt', 'w').write('first\\n')"
      }
      const finalRun: ProvenanceNotebookRun = {
        ...firstRun,
        runId: 'run-2',
        runIndex: 1,
        script: "open('result.txt', 'w').write('final\\n')",
        startedAt: '2026-09-02T00:00:02.000Z',
        completedAt: '2026-09-02T00:00:03.000Z'
      }
      const inputEntity = execution.provenanceGraph!.entities[0]!
      const artifactEntity = execution.provenanceGraph!.entities[2]!
      const graph: ArtifactProvenanceGraph = {
        ...execution.provenanceGraph!,
        activities: [
          execution.provenanceGraph!.activities[0]!,
          {
            activityId: 'run-2',
            kind: 'notebook-run',
            sequence: 1,
            runIndex: 1,
            inclusion: 'target-closure',
            evidenceState: 'available'
          },
          {
            ...execution.provenanceGraph!.activities[1]!,
            sequence: 2,
            parentActivityId: 'run-2'
          }
        ],
        entities: [
          inputEntity,
          {
            entityId: 'file-generation:first',
            kind: 'file-generation',
            generationId: 'first',
            relativePath: 'data/result.txt',
            pathPortability: 'relative',
            checksum: firstChecksum,
            sizeBytes: firstOutput.byteLength,
            contentStorageKey: `execution-file-evidence/blobs/sha256-${firstChecksum}`
          },
          {
            entityId: 'file-generation:final',
            kind: 'file-generation',
            generationId: 'final',
            relativePath: 'data/result.txt',
            pathPortability: 'relative',
            checksum: finalChecksum,
            sizeBytes: finalOutput.byteLength,
            contentStorageKey: `execution-file-evidence/blobs/sha256-${finalChecksum}`
          },
          { ...artifactEntity, checksum: finalChecksum, sizeBytes: finalOutput.byteLength }
        ],
        edges: [
          {
            kind: 'used',
            activityId: 'run-1',
            entityId: inputEntity.entityId,
            authority: 'authoritative',
            evidenceSource: 'registered-contract'
          },
          {
            kind: 'generated',
            activityId: 'run-1',
            entityId: 'file-generation:first',
            authority: 'authoritative',
            evidenceSource: 'runtime-observation'
          },
          {
            kind: 'used',
            activityId: 'run-2',
            entityId: 'file-generation:first',
            authority: 'authoritative',
            evidenceSource: 'runtime-observation'
          },
          {
            kind: 'generated',
            activityId: 'run-2',
            entityId: 'file-generation:final',
            authority: 'authoritative',
            evidenceSource: 'runtime-observation'
          },
          {
            kind: 'used',
            activityId: 'artifact-publication:version-1',
            entityId: 'file-generation:final',
            authority: 'authoritative',
            evidenceSource: 'artifact-publication'
          },
          {
            kind: 'generated',
            activityId: 'artifact-publication:version-1',
            entityId: artifactEntity.entityId,
            authority: 'authoritative',
            evidenceSource: 'artifact-publication'
          }
        ]
      }
      const runs = [firstRun, finalRun]
      execution.runs = runs
      execution.producerRunId = finalRun.runId
      execution.producerRunIndex = finalRun.runIndex
      execution.provenanceGraph = graph
      execution.reproducibilityRecipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: execution.inputFiles,
        runs
      })
      const runtime: NotebookReproductionRuntime = {
        execute: async ({ step, sessionRoot }) => {
          await writeFile(
            join(sessionRoot, 'data', 'result.txt'),
            changed
              ? step.runId === 'run-1'
                ? 'first changed\n'
                : 'final changed\n'
              : step.runId === 'run-1'
                ? firstOutput
                : finalOutput
          )
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: join(sessionRoot, 'data'),
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      }

      const retained: Buffer[] = []
      const result = await executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox,
          retainOutput: async (bytes) => {
            retained.push(bytes)
            return true
          }
        },
        { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
      )

      expect(result).toMatchObject({
        matched: !changed,
        completedStepIds: ['step:run-1', 'step:run-2'],
        comparisons: [
          { entityId: 'file-generation:first', status: changed ? 'different' : 'matched' },
          { entityId: 'file-generation:final', status: changed ? 'different' : 'matched' }
        ]
      })
      expect(retained.map((bytes) => bytes.toString())).toEqual(
        changed ? ['first changed\n', 'final changed\n'] : []
      )
    }
  )

  it.each(['ECONNRESET', 'ENOSPC', 'cancelled'])(
    'cleans up a stopped restore after %s and allows a fresh attempt',
    async (code) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-failed-restore-'))
      const { execution, output } = await fixture(storageRoot)
      const attemptRoot = join(storageRoot, 'attempt')
      const failure = Object.assign(new Error(`restore failed: ${code}`), { code })
      const input = {
        execution,
        frontierId: 'original-inputs',
        storageRoot,
        processSandbox: sandbox
      }
      try {
        await expect(
          executeArtifactReproducibility(input, {
            createAttemptRoot: async () => attemptRoot,
            createRuntime: async () => {
              await mkdir(join(attemptRoot, 'environments', 'partial'), { recursive: true })
              await writeFile(
                join(attemptRoot, 'environments', 'partial', 'package'),
                'partial download'
              )
              throw failure
            }
          })
        ).rejects.toBe(failure)
        await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(
          executeArtifactReproducibility(input, {
            createAttemptRoot: async () => attemptRoot,
            createRuntime: async () => ({
              execute: async ({ sessionRoot }) => {
                await writeFile(join(sessionRoot, 'data', 'result.txt'), output)
                return {
                  status: 'completed',
                  stdout: '',
                  stderr: '',
                  traceback: '',
                  cwdAfter: join(sessionRoot, 'data'),
                  outputs: []
                }
              },
              shutdown: async () => ({ reaped: true })
            })
          })
        ).resolves.toMatchObject({ matched: true })
        await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(storageRoot, { recursive: true, force: true })
      }
    }
  )

  it('removes an empty attempt if writing its ownership marker fails', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-marker-error-'))
    const { execution } = await fixture(storageRoot)
    const attemptRoot = join(storageRoot, 'attempt')
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const createRuntime = vi.fn()
    vi.mocked(writeFile).mockRejectedValueOnce(failure)
    try {
      await expect(
        executeArtifactReproducibility(
          { execution, frontierId: 'original-inputs', storageRoot, processSandbox: sandbox },
          {
            createAttemptRoot: async () => attemptRoot,
            createRuntime
          }
        )
      ).rejects.toBe(failure)
      await expect(access(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(createRuntime).not.toHaveBeenCalled()
    } finally {
      vi.mocked(writeFile).mockReset()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('preserves unknown files when attempt initialization fails', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-marker-existing-'))
    const { execution } = await fixture(storageRoot)
    const attemptRoot = join(storageRoot, 'attempt')
    await mkdir(attemptRoot)
    await writeFile(join(attemptRoot, 'keep.txt'), 'keep')
    try {
      await expect(
        executeArtifactReproducibility(
          { execution, frontierId: 'original-inputs', storageRoot, processSandbox: sandbox },
          {
            createAttemptRoot: async () => attemptRoot
          }
        )
      ).rejects.toThrow('not empty')
      await expect(readFile(join(attemptRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep')
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('preserves the restore failure when temporary workspace cleanup also fails', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-cleanup-error-'))
    const { execution } = await fixture(storageRoot)
    const attemptRoot = join(storageRoot, 'attempt')
    const failure = new Error('package download interrupted')
    const cleanupFailure = Object.assign(new Error('directory busy'), { code: 'EBUSY' })
    vi.mocked(rm).mockRejectedValueOnce(cleanupFailure)
    try {
      await expect(
        executeArtifactReproducibility(
          {
            execution,
            frontierId: 'original-inputs',
            storageRoot,
            processSandbox: sandbox
          },
          {
            createAttemptRoot: async () => attemptRoot,
            createRuntime: async () => {
              throw failure
            }
          }
        )
      ).rejects.toMatchObject({
        message: expect.stringContaining('package download interrupted'),
        errors: [failure, cleanupFailure]
      })
      expect(rm).toHaveBeenCalledWith(
        attemptRoot,
        expect.objectContaining({ maxRetries: 3, retryDelay: 100 })
      )
      await expect(access(attemptRoot)).resolves.toBeUndefined()
    } finally {
      vi.mocked(rm).mockReset()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('retains the attempt when kernel teardown cannot be confirmed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const { execution, output } = await fixture(storageRoot)
    const runtime: NotebookReproductionRuntime = {
      execute: async ({ sessionRoot }) => {
        await writeFile(join(sessionRoot, 'data', 'result.txt'), output)
        return {
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: join(sessionRoot, 'data'),
          outputs: []
        }
      },
      shutdown: async () => ({ reaped: false })
    }

    await expect(
      executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox
        },
        { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
      )
    ).rejects.toThrow(/teardown could not be confirmed/)
    await expect(access(attemptRoot)).resolves.toBeUndefined()
  })

  it('retains the attempt if an environment restore worker cannot be stopped before runtime creation', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const { execution } = await fixture(storageRoot)
    await expect(
      executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox
        },
        {
          createAttemptRoot: async () => attemptRoot,
          createRuntime: async () => {
            throw new Error('RUNTIME_CHILD_UNCONFIRMED')
          }
        }
      )
    ).rejects.toThrow(/teardown could not be confirmed/)
    await expect(access(attemptRoot)).resolves.toBeUndefined()
  })

  it('rejects a source snapshot that drifted after the recipe was sealed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const { execution } = await fixture(storageRoot)
    execution.runs[0]!.script = "open('different.txt', 'w').write('different')"
    const createAttemptRoot = vi.fn(async () => mkdtemp(join(tmpdir(), 'reproduction-attempt-')))

    await expect(
      executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox
        },
        { createAttemptRoot }
      )
    ).rejects.toThrow(/does not match/)
    expect(createAttemptRoot).not.toHaveBeenCalled()
  })

  it('does not create an attempt for a request that was already cancelled', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const { execution } = await fixture(storageRoot)
    const createAttemptRoot = vi.fn(async () => mkdtemp(join(tmpdir(), 'reproduction-attempt-')))

    await expect(
      executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox,
          signal: AbortSignal.abort(new Error('cancelled by test'))
        },
        { createAttemptRoot }
      )
    ).rejects.toThrow('cancelled by test')
    expect(createAttemptRoot).not.toHaveBeenCalled()
  })

  it('refuses a non-empty attempt root without removing its contents', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const sentinel = join(attemptRoot, 'belongs-to-someone-else.txt')
    await writeFile(sentinel, 'keep me')
    const { execution } = await fixture(storageRoot)

    await expect(
      executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox
        },
        { createAttemptRoot: async () => attemptRoot }
      )
    ).rejects.toThrow(/not empty/)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep me')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an output reached through a linked workspace parent',
    async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
      const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
      const linkedRoot = await mkdtemp(join(tmpdir(), 'reproduction-linked-output-'))
      const { execution, output } = await fixture(storageRoot)
      const runtime: NotebookReproductionRuntime = {
        execute: async ({ sessionRoot }) => {
          await rm(join(sessionRoot, 'data'), { recursive: true })
          await symlink(linkedRoot, join(sessionRoot, 'data'), 'dir')
          await writeFile(join(linkedRoot, 'result.txt'), output)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: join(sessionRoot, 'data'),
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      }

      const result = await executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox
        },
        { createAttemptRoot: async () => attemptRoot, createRuntime: async () => runtime }
      )

      expect(result.comparisons).toEqual([
        expect.objectContaining({ status: 'different', reason: 'linked' })
      ])
      await rm(linkedRoot, { recursive: true, force: true })
    }
  )

  for (const kernelKind of ['python', 'r'] as const) {
    it.runIf(reproductionSmokeEnabled && (kernelKind === 'python' || systemRscript !== undefined))(
      `executes multiple outputs and retains logs through a fresh real ${kernelKind} kernel`,
      async () => {
        const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
        const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
        const { execution } = await fixture(storageRoot, kernelKind)
        execution.runs[0]!.script =
          kernelKind === 'python'
            ? "open('result.txt', 'w').write('result\\n')\nopen('summary.txt', 'w').write('summary\\n')\nprint('reproduction log')"
            : 'writeLines("result", "result.txt")\nwriteLines("summary", "summary.txt")\ncat("reproduction log\\n")'
        const graph = execution.provenanceGraph!
        graph.entities.push({
          entityId: 'file-generation:summary',
          kind: 'file-generation',
          generationId: 'summary',
          relativePath: 'data/summary.txt',
          pathPortability: 'relative',
          checksum: sha256('summary\n'),
          sizeBytes: Buffer.byteLength('summary\n'),
          contentStorageKey: `execution-file-evidence/blobs/sha256-${sha256('summary\n')}`
        })
        graph.edges.push({
          kind: 'generated',
          activityId: 'run-1',
          entityId: 'file-generation:summary',
          authority: 'authoritative',
          evidenceSource: 'runtime-observation'
        })
        execution.reproducibilityRecipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: execution.inputFiles,
          runs: execution.runs
        })
        const events: ArtifactReproducibilityExecutionEvent[] = []
        const passThroughSandbox: NotebookProcessSandbox = {
          wrap: async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup: () => undefined
          })
        }

        const result = await executeArtifactReproducibility(
          {
            execution,
            frontierId: 'original-inputs',
            storageRoot,
            processSandbox: passThroughSandbox,
            onEvent: (event) => events.push(event)
          },
          {
            createAttemptRoot: async () => attemptRoot,
            createRuntime: async (input) => {
              const runtime = await createNotebookReproductionRuntime(input, {
                micromamba: '/fake/micromamba',
                runMicromamba: async (argv) => {
                  const prefixIndex = argv.indexOf('-p')
                  const prefix = argv[prefixIndex + 1]
                  if (prefixIndex < 0 || !prefix) throw new Error('Missing test environment prefix')
                  await mkdir(join(prefix, 'bin'), { recursive: true })
                  await symlink(
                    kernelKind === 'python' ? systemPython! : systemRscript!,
                    join(prefix, 'bin', kernelKind === 'python' ? 'python' : 'Rscript')
                  )
                },
                verifyExecutable: async () => undefined,
                verifyEnvironment: async () => undefined,
                createExecutor: ({ processSandbox }) =>
                  new NotebookKernelExecutor({
                    processSandbox,
                    pythonLoopPath: join(process.cwd(), 'resources', 'notebook', 'python_loop.py'),
                    rLoopPath: join(process.cwd(), 'resources', 'notebook', 'r_loop.R')
                  })
              })
              return {
                execute: runtime.execute,
                shutdown: runtime.shutdown
              }
            }
          }
        )

        expect(result).toMatchObject({
          matched: true,
          completedStepIds: ['step:run-1'],
          comparisons: expect.arrayContaining([
            expect.objectContaining({ status: 'matched', relativePath: 'data/result.txt' }),
            expect.objectContaining({ status: 'matched', relativePath: 'data/summary.txt' })
          ])
        })
        expect(events).toContainEqual({
          type: 'step-output',
          entries: expect.arrayContaining([
            expect.objectContaining({
              kernelKind,
              stream: 'stdout',
              text: expect.stringContaining('reproduction log')
            })
          ])
        })
        await expect(access(attemptRoot)).rejects.toThrow()
        await rm(storageRoot, { recursive: true, force: true })
      },
      30_000
    )
  }
})
