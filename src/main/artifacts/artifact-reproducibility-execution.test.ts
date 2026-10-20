import { createNotebookDependencyAnalyzer } from '../notebook/dependency-analysis-adapter'
import { existsSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm), writeFile: vi.fn(fs.writeFile) }
})

import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { stdlibReplayCases } from '../notebook/stdlib-replay.fixture'

import type { NotebookRunRecord } from '../../shared/notebook'
import { sealArtifactProvenanceGraph } from './artifact-provenance-graph'
import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import { createNotebookReproductionRuntime } from '../notebook/reproduction-runtime'
import { reproductionRecipes } from './reproducibility-host'

import { executeArtifactReproducibility } from '../notebook/reproduction-runtime'
import { type ArtifactReproducibilityExecutionEvent } from '@aipoch/reproducibility'
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
  const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
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

describe('host reproducibility kernel integration', () => {
  it.runIf(process.env.RUN_REPRODUCTION_SMOKE === '1')(
    'requires both real kernels when smoke coverage is requested',
    () => {
      expect(process.platform).not.toBe('win32')
      expect(systemPython && existsSync(systemPython)).toBe(true)
      expect(systemRscript && existsSync(systemRscript)).toBe(true)
    }
  )
  it.runIf(reproductionSmokeEnabled).each(stdlibReplayCases)(
    'captures and replays %s through fresh real Python kernels',
    async (_name, script) => {
      const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'stdlib-capture-')))
      const sessionRoot = join(storageRoot, 'notebooks', 'project', 'session')
      const dataRoot = join(sessionRoot, 'data')
      await mkdir(dataRoot, { recursive: true })
      await mkdir(join(sessionRoot, 'handoff'), { recursive: true })
      const executor = new NotebookKernelExecutor({
        pythonBin: systemPython!,
        pythonLoopPath: join(process.cwd(), 'resources', 'notebook', 'python_loop.py')
      })
      let replay: NotebookKernelExecutor | undefined
      try {
        const result = await executor.execute({
          code: script,
          runId: 'run-1',
          language: 'python',
          fileEvidenceStorageRoot: storageRoot,
          cwd: dataRoot,
          notebookSessionRoot: sessionRoot,
          dataRoot,
          resolvedInterpreter: { command: systemPython! },
          runtimeRoot: join(storageRoot, 'runtime')
        })
        const observed = result
        expect(observed.fileEvidence).toBeDefined()
        expect(result.status, JSON.stringify(result)).toBe('completed')
        expect(await readFile(join(dataRoot, 'result.txt'), 'utf8')).toBe('6')
        expect(observed.fileEvidence, JSON.stringify(observed.fileEvidence)).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete'
        })
        const run: NotebookRunRecord = {
          runId: 'run-1',
          cellId: 'cell-1',
          source: 'agent',
          kernelKind: 'python',
          kernelEpochId: 'fresh',
          environment: 'default-python',
          kernelDispatched: true,
          script,
          status: 'completed',
          startedAt: 1,
          endedAt: 2,
          text: { stdout: result.stdout, stderr: result.stderr, traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: observed.workingFiles ?? [],
          inputFiles: [],
          fileEvidence: observed.fileEvidence
        }
        const dependencies = await createNotebookDependencyAnalyzer({
          storageRoot,
          repository: { readSessionRuns: async () => [run] }
        }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
        const evidenceJson = await readFile(
          join(storageRoot, observed.fileEvidence!.storageKey!),
          'utf8'
        )
        const evidence = JSON.parse(evidenceJson) as {
          relations: Array<{
            relativePath: string
            generation?: { generationId: string }
          }>
        }
        const generation = evidence.relations.find(
          (item) => item.relativePath === 'data/result.txt'
        )?.generation
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'version-1',
            filename: 'result.txt',
            checksum: sha256('6'),
            sizeBytes: 1,
            producerRunId: 'run-1',
            sourceGenerationId: generation?.generationId
          },
          notebookActivities: [{ run, runIndex: 0, evidenceJson }],
          computeActivities: [],
          notebookDependencies: dependencies
        })
        expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
        // The existing fixture supplies only environment metadata. File evidence and the graph
        // above are captured by production code, never replaced with a fabricated complete graph.
        const { execution } = await fixture(storageRoot, 'python', 'result.txt', Buffer.from('6'))
        execution.runs[0]!.script = script
        execution.inputFiles = []
        execution.provenanceGraph = graph
        execution.reproducibilityRecipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: [],
          runs: execution.runs
        })
        expect(execution.reproducibilityRecipe.capture.state).toBe('sealed')
        await executor.shutdown()
        const comparison = await executeArtifactReproducibility(
          {
            execution,
            frontierId: 'original-inputs',
            storageRoot,
            processSandbox: sandbox
          },
          {
            // Reuse the installed interpreter in a fresh kernel. This tests capture and replay,
            // not conda lock restoration or the production OS sandbox certification.
            createRuntime: async () => {
              replay = new NotebookKernelExecutor({
                pythonBin: systemPython!,
                pythonLoopPath: join(process.cwd(), 'resources', 'notebook', 'python_loop.py')
              })
              return {
                execute: async ({ source: code, sessionRoot: replayRoot }) => {
                  const executed = await replay!.execute({
                    code,
                    cwd: join(replayRoot, 'data'),
                    notebookSessionRoot: replayRoot,
                    dataRoot: join(replayRoot, 'data'),
                    resolvedInterpreter: { command: systemPython! },
                    runtimeRoot: join(storageRoot, 'runtime')
                  })
                  return { ...executed, outputs: [] }
                },
                shutdown: async () => {
                  return replay!.shutdown()
                }
              }
            }
          }
        )
        expect(comparison).toMatchObject({ matched: true, completedStepIds: ['step:run-1'] })
      } finally {
        await executor.shutdown()
        await replay?.shutdown()
        await rm(storageRoot, { recursive: true, force: true })
      }
    },
    30_000
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
        execution.reproducibilityRecipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
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
            cleanup: async (_reason, outcome) => ({
              processesTerminated: outcome.processesTerminated,
              networkClosed: true,
              temporaryResourcesRemoved: true
            })
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
