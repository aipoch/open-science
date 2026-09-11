import { createHash } from 'node:crypto'
import type { NotebookExecutionContext } from '../../shared/notebook-execution-context'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { ArtifactReproducibilityEnvironmentRequirement } from '../../shared/artifact-provenance'
import type { NotebookEnvironmentLock } from '../../shared/notebook'
import { micromambaCacheLockKey } from './micromamba-cache'
import { withExclusiveCacheLock } from './pkgs-cache-lock'
import type { NotebookSessionExecutor } from './session-aggregate'
import {
  createNotebookReproductionRuntime,
  type CreateNotebookReproductionRuntimeDependencies
} from './reproduction-runtime'
import { pythonBin, rScriptBin } from './runtime-paths'

const serializeLock = (
  platform: string = process.platform,
  kernelKind: 'python' | 'r' = 'python',
  includeNative = false,
  architecture: string = process.arch
): string =>
  JSON.stringify(
    (() => {
      const requirements =
        'numpy==2.0.0 --hash=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
      return {
        schemaVersion: 1,
        format: 'environment-lock-bundle',
        kernelKind,
        environmentName: kernelKind === 'r' ? 'default-r' : 'default-python',
        platform,
        architecture,
        components: [
          {
            ecosystem: 'conda',
            format: 'conda-explicit-md5',
            resolution: 'locked',
            explicitLock:
              '@EXPLICIT\nhttps://repo.example.test/python-3.12.conda#0123456789abcdef0123456789abcdef\n',
            packages: [kernelKind === 'r' ? 'r-base' : 'python', ...(includeNative ? ['pip'] : [])]
          },
          ...(kernelKind === 'python' && includeNative
            ? [
                {
                  ecosystem: 'python',
                  format: 'pip-requirements',
                  resolution: 'locked',
                  files: [
                    {
                      path: 'requirements.lock',
                      checksum: createHash('sha256').update(requirements).digest('hex'),
                      content: requirements
                    }
                  ]
                }
              ]
            : [])
        ],
        ...(includeNative ? { untrackedPackages: ['python:numpy'] } : {})
      }
    })()
  )

const sha256 = async (value: string): Promise<string> => {
  return createHash('sha256').update(value).digest('hex')
}

describe('Notebook reproduction runtime', () => {
  const replayRoots: string[] = []
  afterEach(async () => {
    await Promise.all(
      replayRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    )
  })
  const replayAcrossLocks = async (
    locks: NotebookEnvironmentLock[]
  ): Promise<{
    replay: (
      index: number,
      kernelEpochId?: string,
      defineValues?: boolean,
      executionContext?: NotebookExecutionContext
    ) => ReturnType<NotebookSessionExecutor['execute']>
    runMicromamba: Mock<() => Promise<undefined>>
    execute: Mock<NotebookSessionExecutor['execute']>
    environmentProgress: ReturnType<typeof vi.fn>
    requirements: ArtifactReproducibilityEnvironmentRequirement[]
  }> => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-lock-growth-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-lock-growth-attempt-'))
    replayRoots.push(storageRoot, attemptRoot)
    const requirements: ArtifactReproducibilityEnvironmentRequirement[] = []
    for (const lock of locks) {
      const serialized = JSON.stringify(lock)
      const lockChecksum = await sha256(serialized)
      const path = join(
        storageRoot,
        'runtime',
        'provenance',
        'environment-locks',
        `${lockChecksum}.json`
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, serialized)
      requirements.push({
        requirementId: `environment-lock:${lockChecksum}`,
        kernelKind: lock.kernelKind,
        environmentName: lock.environmentName,
        lockChecksum,
        lockState: 'available'
      })
    }
    const definedInKernels = new Set<string>()
    const execute = vi.fn<NotebookSessionExecutor['execute']>(async (request) => {
      if (request.code.includes('values <-') || request.code.startsWith('values'))
        definedInKernels.add(request.environment!)
      else if (!definedInKernels.has(request.environment!)) throw new Error('values is not defined')
      return {
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: []
      }
    })
    const runMicromamba = vi.fn(async () => undefined)
    const environmentProgress = vi.fn()
    const runtime = await createNotebookReproductionRuntime(
      {
        requirements,
        storageRoot,
        attemptRoot,
        processSandbox: { wrap: vi.fn() },
        projectId: 'project',
        sessionId: 'session',
        onEnvironmentProgress: environmentProgress
      },
      {
        micromamba: '/tools/micromamba',
        runMicromamba,
        restoreNativeLock: vi.fn(async () => undefined),
        verifyEnvironment: vi.fn(async () => undefined),
        verifyExecutable: vi.fn(async () => undefined),
        createExecutor: () => ({ execute, shutdown: async () => ({ reaped: true }) })
      }
    )
    const replay = (
      index: number,
      kernelEpochId = 'unchanged-epoch',
      defineValues = index === 0,
      executionContext?: NotebookExecutionContext
    ): ReturnType<NotebookSessionExecutor['execute']> =>
      runtime.execute({
        step: {
          kind: 'notebook-run',
          stepId: `step-${index}`,
          activityId: `run-${index}`,
          sequence: index,
          runId: `run-${index}`,
          runIndex: index,
          kernelKind: requirements[index]!.kernelKind,
          sourceChecksum: 'a'.repeat(64),
          environmentRequirementId: requirements[index]!.requirementId,
          inputEntityIds: [],
          outputEntityIds: []
        },
        source: defineValues
          ? requirements[index]!.kernelKind === 'r'
            ? 'values <- c(1, 2)'
            : 'values = [1, 2]'
          : 'print(values)',
        sessionRoot: join(attemptRoot, 'workspace'),
        kernelEpochId,
        executionContext
      })
    return { replay, runMicromamba, execute, environmentProgress, requirements }
  }

  it('restores the captured state at each R runtime step', async () => {
    const lock: NotebookEnvironmentLock = JSON.parse(serializeLock(process.platform, 'r'))
    const { replay, execute } = await replayAcrossLocks([lock])
    const observation = {
      locale: 'C',
      timezone: 'UTC',
      threadLimits: {},
      randomLibraries: [],
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
    await replay(0, 'r-epoch', true, { schemaVersion: 1, before: observation, after: observation })
    expect(execute.mock.calls[0]![0].code).toContain('base::RNGkind(')
    expect(execute.mock.calls[0]![0].code).toContain('10407L,1L,2L,3L,4L,5L,6L')
    expect(execute.mock.calls[0]![0].code).toMatch(/values <- c\(1, 2\)$/)
  })

  it('passes Python random state through the kernel protocol without rewriting source', async () => {
    const lock: NotebookEnvironmentLock = JSON.parse(serializeLock())
    const { replay, execute } = await replayAcrossLocks([lock])
    const observation = {
      locale: 'C',
      timezone: 'UTC',
      threadLimits: {},
      randomLibraries: [],
      pythonRandomState: {
        state: 'available' as const,
        standard: { words: [...Array<number>(624).fill(1), 624], gaussian: null }
      }
    }
    await replay(0, 'python-epoch', true, {
      schemaVersion: 1,
      before: observation,
      after: observation
    })
    expect(execute.mock.calls[0]![0].pythonRandomState).toEqual(observation.pythonRandomState)
    expect(execute.mock.calls[0]![0].code).toBe('values = [1, 2]')
  })

  it('does not assume that a newly locked omitted package had the same prior installation identity', async () => {
    const full = JSON.parse(
      serializeLock(process.platform, 'python', true)
    ) as NotebookEnvironmentLock
    const earlier: NotebookEnvironmentLock = {
      ...full,
      components: full.components.filter((component) => component.ecosystem === 'conda'),
      untrackedPackages: undefined,
      omittedPackages: ['python:numpy']
    }
    const { replay, runMicromamba, execute } = await replayAcrossLocks([earlier, full])
    await replay(0)
    await expect(replay(1)).rejects.toThrow('incompatible captured Environment locks')
    expect(runMicromamba).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each(['python', 'r'] as const)(
    'shares identical %s restoration contents despite omission metadata differences',
    async (kernelKind) => {
      const lock = JSON.parse(
        serializeLock(process.platform, kernelKind)
      ) as NotebookEnvironmentLock
      const { replay, runMicromamba, environmentProgress, requirements } = await replayAcrossLocks([
        { ...lock, omittedPackages: [`${kernelKind}:unused`] },
        lock
      ])
      await replay(0)
      await expect(replay(1)).resolves.toMatchObject({ status: 'completed' })
      expect(runMicromamba).toHaveBeenCalledOnce()
      expect(
        environmentProgress.mock.calls
          .filter(([event]) => event.stage === 'completed')
          .map(([event]) => [event.requirementId, event.index])
      ).toEqual(requirements.map((requirement, index) => [requirement.requirementId, index]))
      const indexes = environmentProgress.mock.calls.map(([event]) => event.index)
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
    }
  )

  const pipLock = (declarations: string[]): NotebookEnvironmentLock => {
    const lock = JSON.parse(
      serializeLock(process.platform, 'python', true)
    ) as NotebookEnvironmentLock
    const content = declarations.join('\n') + '\n'
    return {
      ...lock,
      components: [
        lock.components[0]!,
        {
          ecosystem: 'python',
          format: 'pip-requirements',
          resolution: 'locked',
          files: [
            {
              path: 'requirements.lock',
              content,
              checksum: createHash('sha256').update(content).digest('hex')
            }
          ]
        }
      ],
      untrackedPackages: ['python:numpy', 'python:pandas']
    }
  }

  it('shares identical exact pip records in a different declaration order', async () => {
    const declarations = [
      `numpy==2.0.0 --hash=sha256:${'a'.repeat(64)}`,
      `pandas==3.0.0 --hash=sha256:${'b'.repeat(64)}`
    ]
    const { replay, runMicromamba } = await replayAcrossLocks([
      pipLock(declarations),
      pipLock([...declarations].reverse())
    ])
    await replay(0)
    await expect(replay(1)).resolves.toMatchObject({ status: 'completed' })
    expect(runMicromamba).toHaveBeenCalledOnce()
  })

  it.each(['hash', 'version'])(
    'does not share pip locks with different %s evidence',
    async (difference) => {
      const declarations = [
        `numpy==2.0.0 --hash=sha256:${'a'.repeat(64)}`,
        `pandas==3.0.0 --hash=sha256:${'b'.repeat(64)}`
      ]
      const changed =
        difference === 'hash'
          ? [declarations[0]!.replace('a'.repeat(64), 'c'.repeat(64)), declarations[1]!]
          : [declarations[0]!.replace('2.0.0', '2.1.0'), declarations[1]!]
      const { replay, execute } = await replayAcrossLocks([pipLock(declarations), pipLock(changed)])
      await replay(0)
      await expect(replay(1)).rejects.toThrow('incompatible captured Environment locks')
      expect(execute).toHaveBeenCalledOnce()
    }
  )

  it('keeps distinct original epochs separate even with equivalent restored content', async () => {
    const lock = JSON.parse(serializeLock()) as NotebookEnvironmentLock
    const { replay, execute, runMicromamba } = await replayAcrossLocks([
      lock,
      { ...lock, omittedPackages: ['python:unused'] }
    ])
    await replay(0, 'epoch-a')
    await replay(1, 'epoch-b', true)
    expect(runMicromamba).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![0].environment).not.toBe(execute.mock.calls[1]![0].environment)
  })

  it('rejects incompatible locks in the same epoch before dispatching into another kernel', async () => {
    const lock = JSON.parse(serializeLock()) as NotebookEnvironmentLock
    const incompatible = JSON.parse(
      serializeLock().replace('python-3.12.conda', 'python-3.13.conda')
    ) as NotebookEnvironmentLock
    const { replay, execute } = await replayAcrossLocks([lock, incompatible])
    await replay(0)
    await expect(replay(1)).rejects.toThrow('incompatible captured Environment locks')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('restores an exact Conda prefix and executes with the restored interpreter', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const serialized = serializeLock()
    const lockChecksum = await sha256(serialized)
    const lockPath = join(
      storageRoot,
      'runtime',
      'provenance',
      'environment-locks',
      `${lockChecksum}.json`
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, serialized)
    const requirement: ArtifactReproducibilityEnvironmentRequirement = {
      requirementId: `environment-lock:${lockChecksum}`,
      kernelKind: 'python',
      environmentName: 'default-python',
      lockChecksum,
      lockState: 'available'
    }
    const runMicromamba = vi.fn<
      NonNullable<CreateNotebookReproductionRuntimeDependencies['runMicromamba']>
    >(async (_argv, _env, _signal, _onChild, _onBeforeSpawn, _timeoutMs, onOutput) => {
      onOutput?.({ stream: 'stdout', text: 'Linking numpy-2.0.0\n' })
      onOutput?.({ stream: 'stderr', text: 'Using package cache\n' })
    })
    const verifyExecutable = vi.fn<
      NonNullable<CreateNotebookReproductionRuntimeDependencies['verifyExecutable']>
    >(async () => undefined)
    const execute = vi.fn<NotebookSessionExecutor['execute']>(async (request) => ({
      status: 'completed',
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: [],
      helperModulesInitialized: request.helperModules?.map(({ id }) => id)
    }))
    const executor: NotebookSessionExecutor = {
      execute,
      shutdown: vi.fn(async () => ({ reaped: true }))
    }
    const createExecutor = vi.fn(() => executor)
    const processSandbox = { wrap: vi.fn() }
    const environmentProgress = vi.fn()
    const environmentOutput = vi.fn()

    const runtime = await createNotebookReproductionRuntime(
      {
        requirements: [requirement],
        storageRoot,
        attemptRoot,
        processSandbox,
        projectId: 'artifact-reproducibility',
        sessionId: 'reproduction-1',
        onEnvironmentProgress: environmentProgress,
        onEnvironmentOutput: environmentOutput
      },
      {
        micromamba: '/tools/micromamba',
        runMicromamba,
        verifyExecutable,
        verifyEnvironment: vi.fn(async () => undefined),
        createExecutor
      }
    )

    expect(runMicromamba).toHaveBeenCalledTimes(1)
    expect(createExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        pythonLoopPath: expect.stringMatching(/python_loop\.py$/),
        rLoopPath: expect.stringMatching(/r_loop\.R$/),
        replLoopPath: expect.stringMatching(/repl_loop\.js$/)
      })
    )
    expect(environmentProgress.mock.calls.map(([event]) => event.stage)).toEqual([
      'validating-lock',
      'restoring-packages',
      'verifying-runtime',
      'completed'
    ])
    expect(environmentProgress).toHaveBeenLastCalledWith({
      requirementId: requirement.requirementId,
      kernelKind: 'python',
      index: 0,
      total: 1,
      stage: 'completed'
    })
    expect(environmentOutput.mock.calls.map(([event]) => event)).toEqual([
      {
        requirementId: requirement.requirementId,
        kernelKind: 'python',
        index: 0,
        total: 1,
        stream: 'stdout',
        text: 'Linking numpy-2.0.0\n'
      },
      {
        requirementId: requirement.requirementId,
        kernelKind: 'python',
        index: 0,
        total: 1,
        stream: 'stderr',
        text: 'Using package cache\n'
      }
    ])
    const argv = runMicromamba.mock.calls[0]![0]
    expect(runMicromamba.mock.calls[0]![1]?.CONDA_PKGS_DIRS).toBe(
      join(storageRoot, 'runtime', 'pkgs')
    )
    expect(argv).toEqual(
      expect.arrayContaining([
        '/tools/micromamba',
        '--no-rc',
        'create',
        '--offline',
        '--no-pyc',
        '--root-prefix',
        join(storageRoot, 'runtime')
      ])
    )
    expect(argv.join(' ')).not.toContain('requirements.lock')

    await runtime.execute({
      step: {
        kind: 'notebook-run',
        stepId: 'step:run-1',
        activityId: 'run-1',
        sequence: 0,
        runId: 'run-1',
        runIndex: 0,
        kernelKind: 'python',
        sourceChecksum: 'a'.repeat(64),
        environmentRequirementId: requirement.requirementId,
        inputEntityIds: [],
        outputEntityIds: []
      },
      source: 'print(1)',
      sessionRoot: join(attemptRoot, 'workspace')
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'print(1)',
        runtimeRoot: join(attemptRoot, 'runtime'),
        protectedDirs: [storageRoot],
        resolvedInterpreter: expect.objectContaining({
          condaPrefix: join(attemptRoot, 'environments', lockChecksum)
        })
      })
    )

    const helperSource = 'def normalize(value):\n    return value\n'
    const helper = {
      helperId: 'normalize-data',
      skillIdentity: 'skill-1',
      packageOrigin: 'builtin',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['normalize'],
      source: helperSource,
      sourceDigest: createHash('sha256').update(helperSource).digest('hex')
    }
    const helperStep = (
      runId: string
    ): Extract<
      import('../../shared/artifact-provenance').ArtifactReproducibilityRecipeStep,
      { kind: 'notebook-run' }
    > => ({
      kind: 'notebook-run' as const,
      stepId: `step:${runId}`,
      activityId: runId,
      sequence: Number(runId.slice(4)),
      runId,
      runIndex: Number(runId.slice(4)),
      kernelKind: 'python' as const,
      sourceChecksum: 'a'.repeat(64),
      environmentRequirementId: requirement.requirementId,
      inputEntityIds: [],
      outputEntityIds: []
    })
    await runtime.execute({
      step: helperStep('run-2'),
      source: 'normalize(1)',
      sessionRoot: join(attemptRoot, 'workspace'),
      kernelEpochId: 'epoch-a',
      helperModules: [helper]
    })
    await runtime.execute({
      step: helperStep('run-3'),
      source: 'normalize(2)',
      sessionRoot: join(attemptRoot, 'workspace'),
      kernelEpochId: 'epoch-a',
      helperModules: [helper]
    })
    await runtime.execute({
      step: helperStep('run-4'),
      source: 'normalize(3)',
      sessionRoot: join(attemptRoot, 'workspace'),
      kernelEpochId: 'epoch-b',
      helperModules: [helper]
    })

    const helperRequests = execute.mock.calls.slice(1).map(([request]) => request)
    expect(helperRequests[0]!.environment).toBe(helperRequests[1]!.environment)
    expect(helperRequests[2]!.environment).not.toBe(helperRequests[1]!.environment)
    expect(helperRequests.map(({ helperModules }) => helperModules?.length ?? 0)).toEqual([1, 0, 1])
  })

  it('rejects partial and cross-platform locks before launching micromamba', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const runMicromamba = vi.fn<
      NonNullable<CreateNotebookReproductionRuntimeDependencies['runMicromamba']>
    >(async () => undefined)
    const processSandbox = { wrap: vi.fn() }
    const partial: ArtifactReproducibilityEnvironmentRequirement = {
      requirementId: 'partial',
      kernelKind: 'python',
      lockChecksum: 'a'.repeat(64),
      lockState: 'partial'
    }
    await expect(
      createNotebookReproductionRuntime(
        {
          requirements: [partial],
          storageRoot,
          attemptRoot,
          processSandbox,
          projectId: 'artifact-reproducibility',
          sessionId: 'reproduction-1'
        },
        { micromamba: '/tools/micromamba', runMicromamba }
      )
    ).rejects.toThrow(/not exact/)

    const serialized = serializeLock(process.platform === 'win32' ? 'linux' : 'win32')
    const lockChecksum = await sha256(serialized)
    const lockPath = join(
      storageRoot,
      'runtime',
      'provenance',
      'environment-locks',
      `${lockChecksum}.json`
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, serialized)
    await expect(
      createNotebookReproductionRuntime(
        {
          requirements: [
            {
              requirementId: `environment-lock:${lockChecksum}`,
              kernelKind: 'python',
              environmentName: 'default-python',
              lockChecksum,
              lockState: 'available'
            }
          ],
          storageRoot,
          attemptRoot,
          processSandbox,
          projectId: 'artifact-reproducibility',
          sessionId: 'reproduction-1'
        },
        { micromamba: '/tools/micromamba', runMicromamba }
      )
    ).rejects.toThrow(/another platform/)
    expect(runMicromamba).not.toHaveBeenCalled()
  })

  it('accepts equivalent runtime architecture names', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const capturedArchitecture = process.arch === 'x64' ? 'x86_64' : 'aarch64'
    const runtimeArchitecture = process.arch === 'x64' ? 'AMD64' : 'arm64'
    const serialized = serializeLock(process.platform, 'python', false, capturedArchitecture)
    const lockChecksum = await sha256(serialized)
    const lockPath = join(
      storageRoot,
      'runtime',
      'provenance',
      'environment-locks',
      `${lockChecksum}.json`
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, serialized)
    const runMicromamba = vi.fn(async () => undefined)

    await expect(
      createNotebookReproductionRuntime(
        {
          requirements: [
            {
              requirementId: `environment-lock:${lockChecksum}`,
              kernelKind: 'python',
              environmentName: 'default-python',
              lockChecksum,
              lockState: 'available'
            }
          ],
          storageRoot,
          attemptRoot,
          processSandbox: { wrap: vi.fn() },
          projectId: 'artifact-reproducibility',
          sessionId: 'reproduction-architecture'
        },
        {
          micromamba: '/tools/micromamba',
          runMicromamba,
          architecture: runtimeArchitecture,
          verifyEnvironment: vi.fn(async () => undefined),
          verifyExecutable: vi.fn(async () => undefined)
        }
      )
    ).resolves.toBeDefined()
    expect(runMicromamba).toHaveBeenCalledOnce()
  })

  it('waits for shared package-cache maintenance before restoring Conda', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const serialized = serializeLock('linux')
    const lockChecksum = await sha256(serialized)
    const lockPath = join(
      storageRoot,
      'runtime',
      'provenance',
      'environment-locks',
      `${lockChecksum}.json`
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, serialized)
    let releaseMaintenance!: () => void
    const maintenance = withExclusiveCacheLock(
      micromambaCacheLockKey(join(storageRoot, 'runtime', 'pkgs'), { platform: 'linux' }),
      () => new Promise<void>((resolve) => (releaseMaintenance = resolve))
    )
    const runMicromamba = vi.fn(async () => undefined)
    const creating = createNotebookReproductionRuntime(
      {
        requirements: [
          {
            requirementId: `environment-lock:${lockChecksum}`,
            kernelKind: 'python',
            environmentName: 'default-python',
            lockChecksum,
            lockState: 'available'
          }
        ],
        storageRoot,
        attemptRoot,
        processSandbox: { wrap: vi.fn() },
        projectId: 'artifact-reproducibility',
        sessionId: 'reproduction-cache-lock'
      },
      {
        micromamba: '/tools/micromamba',
        runMicromamba,
        platform: 'linux',
        verifyEnvironment: vi.fn(async () => undefined),
        verifyExecutable: vi.fn(async () => undefined)
      }
    )

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(runMicromamba).not.toHaveBeenCalled()
    releaseMaintenance()
    await maintenance
    await expect(creating).resolves.toBeDefined()
    expect(runMicromamba).toHaveBeenCalledOnce()
  })

  it.each(['python', 'r'] as const)(
    'stops %s restoration at cancellation boundaries',
    async (kernelKind) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-cancel-'))
      replayRoots.push(storageRoot)
      const serialized = serializeLock(process.platform, kernelKind)
      const lockChecksum = await sha256(serialized)
      const lockPath = join(
        storageRoot,
        'runtime',
        'provenance',
        'environment-locks',
        `${lockChecksum}.json`
      )
      await mkdir(dirname(lockPath), { recursive: true })
      await writeFile(lockPath, serialized)
      for (const stage of [
        'initial',
        'restoring-packages',
        'conda',
        'native',
        'verifying-runtime',
        'verify',
        'metadata',
        'completed'
      ]) {
        const controller = new AbortController()
        const reason = new Error(`cancelled at ${stage}`)
        const cancelAt = (current: string): void => {
          if (stage === current) controller.abort(reason)
        }
        const runMicromamba = vi.fn(async () => cancelAt('conda'))
        const restoreNativeLock = vi.fn(async () => cancelAt('native'))
        const verifyExecutable = vi.fn(async () => cancelAt('verify'))
        const verifyEnvironment = vi.fn(async () => cancelAt('metadata'))
        const createExecutor = vi.fn()
        const progress = vi.fn(({ stage }: { stage: string }) => cancelAt(stage))
        cancelAt('initial')
        await expect(
          createNotebookReproductionRuntime(
            {
              requirements: [
                {
                  requirementId: 'env',
                  kernelKind,
                  environmentName: `default-${kernelKind}`,
                  lockChecksum,
                  lockState: 'available'
                }
              ],
              storageRoot,
              attemptRoot: join(storageRoot, stage),
              signal: controller.signal,
              processSandbox: { wrap: vi.fn() },
              projectId: 'project',
              sessionId: 'session',
              onEnvironmentProgress: progress
            },
            {
              micromamba: '/tools/micromamba',
              runMicromamba,
              restoreNativeLock,
              verifyExecutable,
              verifyEnvironment,
              createExecutor
            }
          )
        ).rejects.toBe(reason)
        expect(createExecutor).not.toHaveBeenCalled()
        expect(runMicromamba).toHaveBeenCalledTimes(
          ['initial', 'restoring-packages'].includes(stage) ? 0 : 1
        )
        expect(restoreNativeLock).toHaveBeenCalledTimes(
          ['initial', 'restoring-packages', 'conda'].includes(stage) ? 0 : 1
        )
        expect(verifyExecutable).toHaveBeenCalledTimes(
          ['verify', 'metadata', 'completed'].includes(stage) ? 1 : 0
        )
        expect(verifyEnvironment).toHaveBeenCalledTimes(
          ['metadata', 'completed'].includes(stage) ? 1 : 0
        )
        if (stage !== 'completed')
          expect(progress.mock.calls.some(([event]) => event.stage === 'completed')).toBe(false)
      }
    }
  )

  it('restores an exact native package lock after the Conda baseline', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const serialized = serializeLock(process.platform, 'python', true)
    const lockChecksum = await sha256(serialized)
    const lockPath = join(
      storageRoot,
      'runtime',
      'provenance',
      'environment-locks',
      `${lockChecksum}.json`
    )
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, serialized)
    const runMicromamba = vi.fn()
    const restoreNativeLock = vi.fn()
    const verifyExecutable = vi.fn()

    await expect(
      createNotebookReproductionRuntime(
        {
          requirements: [
            {
              requirementId: `environment-lock:${lockChecksum}`,
              kernelKind: 'python',
              environmentName: 'default-python',
              lockChecksum,
              lockState: 'available'
            }
          ],
          storageRoot,
          attemptRoot,
          processSandbox: { wrap: vi.fn() },
          projectId: 'artifact-reproducibility',
          sessionId: 'reproduction-native-lock'
        },
        {
          micromamba: '/tools/micromamba',
          runMicromamba,
          restoreNativeLock,
          verifyExecutable,
          verifyEnvironment: vi.fn(async () => undefined)
        }
      )
    ).resolves.toBeDefined()
    expect(runMicromamba).toHaveBeenCalledOnce()
    expect(restoreNativeLock).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: expect.objectContaining({ untrackedPackages: ['python:numpy'] }),
        prefix: expect.stringContaining(lockChecksum)
      })
    )
    expect(verifyExecutable).toHaveBeenCalledOnce()
  })

  it('routes Python and R steps through distinct restored kernel identities', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'reproduction-storage-'))
    const attemptRoot = await mkdtemp(join(tmpdir(), 'reproduction-attempt-'))
    const requirements: ArtifactReproducibilityEnvironmentRequirement[] = []
    for (const kernelKind of ['python', 'r'] as const) {
      const serialized = serializeLock(process.platform, kernelKind)
      const lockChecksum = await sha256(serialized)
      const lockPath = join(
        storageRoot,
        'runtime',
        'provenance',
        'environment-locks',
        `${lockChecksum}.json`
      )
      await mkdir(dirname(lockPath), { recursive: true })
      await writeFile(lockPath, serialized)
      requirements.push({
        requirementId: `environment-lock:${lockChecksum}`,
        kernelKind,
        environmentName: kernelKind === 'r' ? 'default-r' : 'default-python',
        lockChecksum,
        lockState: 'available'
      })
    }
    const execute = vi.fn<NotebookSessionExecutor['execute']>(async (request) => ({
      status: 'completed',
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const executor: NotebookSessionExecutor = {
      execute,
      shutdown: vi.fn(async () => ({ reaped: true }))
    }
    const runtime = await createNotebookReproductionRuntime(
      {
        requirements,
        storageRoot,
        attemptRoot,
        processSandbox: { wrap: vi.fn() },
        projectId: 'artifact-reproducibility',
        sessionId: 'reproduction-1'
      },
      {
        micromamba: '/tools/micromamba',
        runMicromamba: async () => undefined,
        verifyExecutable: async () => undefined,
        verifyEnvironment: vi.fn(async () => undefined),
        createExecutor: () => executor
      }
    )

    for (const [index, requirement] of requirements.entries()) {
      await runtime.execute({
        step: {
          kind: 'notebook-run',
          stepId: `step:${requirement.kernelKind}`,
          activityId: `run-${index}`,
          sequence: index,
          runId: `run-${index}`,
          runIndex: index,
          kernelKind: requirement.kernelKind,
          sourceChecksum: 'a'.repeat(64),
          environmentRequirementId: requirement.requirementId,
          inputEntityIds: [],
          outputEntityIds: []
        },
        source: 'print(1)',
        sessionRoot: join(attemptRoot, 'workspace'),
        kernelEpochId: `epoch-${requirement.kernelKind}`
      })
    }

    const requests = execute.mock.calls.map(([request]) => request)
    expect(requests.map(({ language }) => language)).toEqual(['python', 'r'])
    expect(requests[0]!.environment).not.toBe(requests[1]!.environment)
    expect(requests[0]!.resolvedInterpreter?.command).toBe(
      pythonBin(join(attemptRoot, 'environments', requirements[0]!.lockChecksum))
    )
    expect(requests[1]!.resolvedInterpreter?.command).toBe(
      rScriptBin(join(attemptRoot, 'environments', requirements[1]!.lockChecksum))
    )
  })
})
