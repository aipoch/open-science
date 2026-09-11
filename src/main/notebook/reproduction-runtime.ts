import { createHash } from 'node:crypto'
import { restoreRRandomState } from './r-random-replay'
import { validatePythonRandomState } from './python-random-replay'
import type { NotebookExecutionContext } from '../../shared/notebook-execution-context'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ArtifactReproducibilityEnvironmentRequirement,
  ArtifactReproducibilityRecipeStep
} from '../../shared/artifact-provenance'
import type { NotebookEnvironmentLock, NotebookHelperModuleEvidence } from '../../shared/notebook'
import { parseNotebookEnvironmentLock } from './environment-lock'
import { NotebookHelperModuleHost } from './helper-module-host'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import { createFromLockArgv, micromambaSpawnEnv, resolveMicromamba } from './micromamba'
import { micromambaCacheLockKey, selectMicromambaCache } from './micromamba-cache'
import { nativeLockRestoreState, restoreNativeEnvironmentLock } from './native-lock-restoration'
import { prepareNotebookWorkloadCache } from './notebook-workload-cache-paths'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import { withSharedCacheLocks } from './pkgs-cache-lock'
import type { NotebookProcessSandbox } from './process-sandbox'
import { runMicromamba, verifyExecutable } from './provisioner-runtime'
import { verifyRestoredEnvironment } from './restored-environment-verification'
import { buildManagedRuntimeProcessEnvironment } from './process-environment'
import { resolveLoopScriptPaths } from './runtime-service'
import {
  normalizeRuntimeArchitecture,
  pkgsCache,
  pythonBin,
  rScriptBin,
  runtimeRoot
} from './runtime-paths'
import type {
  NotebookKernelEpochOwnership,
  NotebookSessionExecutionResult,
  NotebookSessionExecutor
} from './session-aggregate'
import { resolveStorageKey, storageKey } from '../artifacts/provenance-storage'

type NotebookReproductionStep = Extract<ArtifactReproducibilityRecipeStep, { kind: 'notebook-run' }>

type NotebookReproductionRuntime = {
  execute(input: {
    step: NotebookReproductionStep
    source: string
    executionContext?: NotebookExecutionContext
    sessionRoot: string
    kernelEpochId?: string
    helperModules?: NotebookHelperModuleEvidence[]
    signal?: AbortSignal
  }): Promise<NotebookSessionExecutionResult>
  shutdown(): Promise<{ reaped: boolean }>
}

type CreateNotebookReproductionRuntimeInput = {
  requirements: ArtifactReproducibilityEnvironmentRequirement[]
  storageRoot: string
  attemptRoot: string
  processSandbox: NotebookProcessSandbox
  signal?: AbortSignal
  projectId: string
  sessionId: string
  onEnvironmentProgress?: (event: NotebookReproductionEnvironmentProgress) => void
  onEnvironmentOutput?: (event: NotebookReproductionEnvironmentOutput) => void
}

type NotebookReproductionEnvironmentProgress = {
  requirementId: string
  kernelKind: 'python' | 'r'
  index: number
  total: number
  stage: 'validating-lock' | 'restoring-packages' | 'verifying-runtime' | 'completed'
}

type NotebookReproductionEnvironmentOutput = {
  requirementId: string
  kernelKind: 'python' | 'r'
  index: number
  total: number
  stream: 'stdout' | 'stderr'
  text: string
}

type CreateNotebookReproductionRuntimeDependencies = {
  micromamba?: string
  runMicromamba?: typeof runMicromamba
  verifyExecutable?: typeof verifyExecutable
  verifyEnvironment?: typeof verifyRestoredEnvironment
  createExecutor?: (options: NotebookKernelExecutorOptions) => NotebookSessionExecutor
  restoreNativeLock?: typeof restoreNativeEnvironmentLock
  platform?: NodeJS.Platform
  architecture?: string
}

type RestoredEnvironment = {
  environmentName: string
  prefix: string
  command: string
}

type HelperEpoch = {
  ownership: NotebookKernelEpochOwnership
  host: NotebookHelperModuleHost
  activeById: Map<string, NotebookHelperModuleEvidence>
}

const helperDescriptor = (
  helper: NotebookHelperModuleEvidence
): {
  id: string
  language: 'python'
  source: string
  sourceDigest: string
  exports: string[]
  dependencies?: string[]
  skillIdentity: string
  packageOrigin: string
  interfaceRevision: string
  registeredGeneration: string
} => ({
  id: helper.helperId,
  language: 'python' as const,
  source: helper.source,
  sourceDigest: helper.sourceDigest,
  exports: helper.exports,
  dependencies: helper.dependencies,
  skillIdentity: helper.skillIdentity,
  packageOrigin: helper.packageOrigin,
  interfaceRevision: helper.interfaceRevision,
  registeredGeneration: helper.registeredGeneration
})

const environmentLockPath = (storageRoot: string, checksum: string): string =>
  resolveStorageKey(
    storageRoot,
    storageKey('runtime', 'provenance', 'environment-locks', `${checksum}.json`)
  )

const loadEnvironmentLock = async (
  requirement: ArtifactReproducibilityEnvironmentRequirement,
  input: CreateNotebookReproductionRuntimeInput,
  dependencies: CreateNotebookReproductionRuntimeDependencies
): Promise<NotebookEnvironmentLock> => {
  if (requirement.lockState !== 'available') {
    throw new Error(`Reproducibility Environment lock is not exact: ${requirement.requirementId}`)
  }
  const serialized = await readFile(
    environmentLockPath(input.storageRoot, requirement.lockChecksum),
    'utf8'
  )
  if (createHash('sha256').update(serialized).digest('hex') !== requirement.lockChecksum) {
    throw new Error(
      `Reproducibility Environment lock checksum changed: ${requirement.requirementId}`
    )
  }
  const lock = parseNotebookEnvironmentLock(serialized)
  if (
    lock.kernelKind !== requirement.kernelKind ||
    (requirement.environmentName !== undefined &&
      lock.environmentName !== requirement.environmentName)
  ) {
    throw new Error(
      `Reproducibility Environment lock identity changed: ${requirement.requirementId}`
    )
  }
  const platform = dependencies.platform ?? process.platform
  if (
    (lock.platform !== undefined && lock.platform !== platform) ||
    (lock.architecture !== undefined &&
      normalizeRuntimeArchitecture(lock.architecture) !==
        normalizeRuntimeArchitecture(dependencies.architecture ?? process.arch))
  ) {
    throw new Error(`Reproducibility Environment lock targets another platform.`)
  }
  const conda = lock.components.find((component) => component.ecosystem === 'conda')
  if (!conda || conda.format !== 'conda-explicit-md5') {
    throw new Error(`Reproducibility Environment lock has no exact Conda component.`)
  }
  if (nativeLockRestoreState(lock).state === 'unsupported') {
    throw new Error(
      `Reproducibility Environment lock has no exact restorable native package component: ${requirement.requirementId}`
    )
  }

  return lock
}

// Reuse only identical restoration contents, never merge locks or mutate a running prefix.
// Omission records contain names but no prior package version/hash, so they cannot prove that
// a larger native lock preserves the earlier environment. Pip declaration order can differ;
// other native lock formats must have identical payloads before they can share a runtime.
const restoreIdentity = (lock: NotebookEnvironmentLock): string => {
  const state = nativeLockRestoreState(lock)
  const component = state.state === 'ready' ? state.plan.component : undefined
  let pip: Map<string, string> | undefined
  if (component?.format === 'pip-requirements' && component.files.length === 1) {
    pip = new Map()
    for (const line of component.files[0]!.content.replace(/\\\r?\n/gu, ' ').split(/\r?\n/u)) {
      const declaration = line.trim()
      if (!declaration || declaration.startsWith('#')) continue
      const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)(?:\s+--hash=sha256:[a-f0-9]{64})+$/u.exec(
        declaration
      )
      const name = match?.[1]?.toLowerCase().replace(/[-_.]+/gu, '-')
      if (!name || pip.has(name)) {
        pip = undefined
        break
      }
      pip.set(name, declaration)
    }
  }
  return JSON.stringify([
    lock.kernelKind,
    lock.environmentName,
    lock.platform,
    lock.architecture === undefined ? undefined : normalizeRuntimeArchitecture(lock.architecture),
    lock.components.find((candidate) => candidate.ecosystem === 'conda'),
    pip
      ? ['pip-requirements', [...pip].sort(([left], [right]) => left.localeCompare(right))]
      : component
  ])
}

const restoreEnvironment = async (
  requirement: ArtifactReproducibilityEnvironmentRequirement,
  lock: NotebookEnvironmentLock,
  input: CreateNotebookReproductionRuntimeInput,
  dependencies: CreateNotebookReproductionRuntimeDependencies,
  index: number
): Promise<RestoredEnvironment> => {
  input.signal?.throwIfAborted()
  const progress = (stage: NotebookReproductionEnvironmentProgress['stage']): void =>
    input.onEnvironmentProgress?.({
      requirementId: requirement.requirementId,
      kernelKind: requirement.kernelKind,
      index,
      total: input.requirements.length,
      stage
    })
  const platform = dependencies.platform ?? process.platform
  const conda = lock.components.find((component) => component.ecosystem === 'conda')!

  const mm = dependencies.micromamba ?? resolveMicromamba()
  if (!mm) throw new Error('Micromamba is unavailable for reproducibility execution.')

  const locksRoot = join(input.attemptRoot, 'locks')
  const environmentsRoot = join(input.attemptRoot, 'environments')
  await Promise.all([
    mkdir(locksRoot, { recursive: true, mode: 0o700 }),
    mkdir(environmentsRoot, { recursive: true, mode: 0o700 })
  ])
  const lockPath = join(locksRoot, `${requirement.lockChecksum}.lock`)
  await writeFile(lockPath, conda.explicitLock, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const prefix = join(environmentsRoot, requirement.lockChecksum)
  const sharedRuntimeRoot = runtimeRoot(input.storageRoot)
  const cache = selectMicromambaCache(sharedRuntimeRoot, undefined, { platform })
  const cacheLockKeys = [
    cache.lockKey,
    micromambaCacheLockKey(pkgsCache(sharedRuntimeRoot), { platform })
  ]
  progress('restoring-packages')
  const bufferedOutput: Array<Pick<NotebookReproductionEnvironmentOutput, 'stream' | 'text'>> = []
  let outputTimer: ReturnType<typeof setTimeout> | undefined
  const flushOutput = (): void => {
    if (outputTimer) clearTimeout(outputTimer)
    outputTimer = undefined
    for (const { stream, text } of bufferedOutput.splice(0)) {
      input.onEnvironmentOutput?.({
        requirementId: requirement.requirementId,
        kernelKind: requirement.kernelKind,
        index,
        total: input.requirements.length,
        stream,
        text
      })
    }
  }
  const bufferOutput = ({ stream, text }: { stream: 'stdout' | 'stderr'; text: string }): void => {
    const previous = bufferedOutput.at(-1)
    if (previous?.stream === stream) previous.text += text
    else bufferedOutput.push({ stream, text })
    outputTimer ??= setTimeout(flushOutput, 100)
  }
  try {
    await withSharedCacheLocks(cacheLockKeys, () => {
      input.signal?.throwIfAborted()
      return (dependencies.runMicromamba ?? runMicromamba)(
        // Python attempts are short-lived: compile only modules actually imported during replay,
        // instead of eagerly compiling every Python package in the restored inventory.
        createFromLockArgv(mm, sharedRuntimeRoot, prefix, lockPath, {
          compilePyc: requirement.kernelKind !== 'python'
        }),
        micromambaSpawnEnv(sharedRuntimeRoot, undefined, {
          platform,
          selectCache: () => cache
        }),
        input.signal,
        undefined,
        undefined,
        undefined,
        bufferOutput
      )
    })
    input.signal?.throwIfAborted()
    const nativeLocksRoot = join(locksRoot, requirement.lockChecksum)
    await (dependencies.restoreNativeLock ?? restoreNativeEnvironmentLock)({
      lock,
      prefix,
      locksRoot: nativeLocksRoot,
      platform,
      inheritedEnv: prepareNotebookWorkloadCache(sharedRuntimeRoot),
      signal: input.signal,
      spawn: sandboxedPackageSpawn({
        processSandbox: input.processSandbox,
        request: {
          projectId: input.projectId,
          sessionId: input.sessionId,
          language: requirement.kernelKind,
          packages: [],
          environment: `repro-${requirement.lockChecksum.slice(0, 12)}`,
          workspaceCwd: nativeLocksRoot
        },
        runtimeRoot: sharedRuntimeRoot,
        storageRoot: input.storageRoot,
        interpreter: {
          command:
            requirement.kernelKind === 'r'
              ? rScriptBin(prefix, platform)
              : pythonBin(prefix, platform),
          condaPrefix: prefix
        },
        platform
      }),
      onOutput: bufferOutput
    })
  } finally {
    flushOutput()
  }

  const command =
    requirement.kernelKind === 'r' ? rScriptBin(prefix, platform) : pythonBin(prefix, platform)
  input.signal?.throwIfAborted()
  progress('verifying-runtime')
  input.signal?.throwIfAborted()
  const env = buildManagedRuntimeProcessEnvironment(sharedRuntimeRoot, {
    language: requirement.kernelKind,
    prefix,
    platform
  })
  await (dependencies.verifyExecutable ?? verifyExecutable)(command, {
    prefix,
    platform,
    signal: input.signal,
    env,
    completeEnv: true
  })
  input.signal?.throwIfAborted()
  await (dependencies.verifyEnvironment ?? verifyRestoredEnvironment)({
    lock,
    prefix,
    env,
    signal: input.signal,
    platform,
    spawn: sandboxedPackageSpawn({
      processSandbox: input.processSandbox,
      request: {
        projectId: input.projectId,
        sessionId: input.sessionId,
        language: requirement.kernelKind,
        packages: [],
        workspaceCwd: prefix
      },
      runtimeRoot: sharedRuntimeRoot,
      storageRoot: input.storageRoot,
      interpreter: { command, condaPrefix: prefix },
      platform
    })
  })
  input.signal?.throwIfAborted()
  progress('completed')
  return {
    environmentName: `repro-${requirement.lockChecksum.slice(0, 12)}`,
    prefix,
    command
  }
}

const createNotebookReproductionRuntime = async (
  input: CreateNotebookReproductionRuntimeInput,
  dependencies: CreateNotebookReproductionRuntimeDependencies = {}
): Promise<NotebookReproductionRuntime> => {
  input.signal?.throwIfAborted()
  const restored = new Map<string, RestoredEnvironment>()
  const captured: Array<{
    requirement: ArtifactReproducibilityEnvironmentRequirement
    lock: NotebookEnvironmentLock
    identity: ReturnType<typeof restoreIdentity>
  }> = []
  for (const requirement of input.requirements) {
    input.signal?.throwIfAborted()
    const lock = await loadEnvironmentLock(requirement, input, dependencies)
    captured.push({
      requirement,
      lock,
      identity: restoreIdentity(lock)
    })
  }
  const restoredByIdentity = new Map<string, RestoredEnvironment>()
  for (const [index, { requirement, lock, identity }] of captured.entries()) {
    input.signal?.throwIfAborted()
    // Publish validated entries in restoration order; a preflight over all locks must not
    // make the visible environment number jump backwards before restoration begins.
    input.onEnvironmentProgress?.({
      requirementId: requirement.requirementId,
      kernelKind: requirement.kernelKind,
      index,
      total: input.requirements.length,
      stage: 'validating-lock'
    })
    let environment = restoredByIdentity.get(identity)
    if (!environment) {
      environment = await restoreEnvironment(requirement, lock, input, dependencies, index)
      restoredByIdentity.set(identity, environment)
    } else {
      input.onEnvironmentProgress?.({
        requirementId: requirement.requirementId,
        kernelKind: requirement.kernelKind,
        index,
        total: input.requirements.length,
        stage: 'completed'
      })
    }
    restored.set(requirement.requirementId, environment)
  }
  input.signal?.throwIfAborted()
  const executorOptions: NotebookKernelExecutorOptions = {
    ...resolveLoopScriptPaths(),
    processSandbox: input.processSandbox
  }
  const executor =
    dependencies.createExecutor?.(executorOptions) ?? new NotebookKernelExecutor(executorOptions)
  const helperEpochs = new Map<string, HelperEpoch>()
  const environmentNames = new Map<string, string>()
  const epochPrefixes = new Map<string, string>()

  const executionEnvironment = (
    step: NotebookReproductionStep,
    environment: RestoredEnvironment,
    kernelEpochId: string | undefined
  ): { name: string; epochKey: string } => {
    const originalEpoch = [step.kernelKind, kernelEpochId ?? step.runId].join('\0')
    const priorPrefix = epochPrefixes.get(originalEpoch)
    if (priorPrefix && priorPrefix !== environment.prefix) {
      throw new Error(
        'Cannot replay incompatible captured Environment locks in one Notebook kernel epoch.'
      )
    }
    epochPrefixes.set(originalEpoch, environment.prefix)
    const epochKey = [step.kernelKind, environment.prefix, kernelEpochId ?? step.runId].join('\0')
    let name = environmentNames.get(epochKey)
    if (!name) {
      name = `${environment.environmentName}-${environmentNames.size + 1}`
      environmentNames.set(epochKey, name)
    }
    return { name, epochKey }
  }

  return {
    execute: async ({
      step,
      source,
      executionContext,
      sessionRoot,
      kernelEpochId,
      helperModules = [],
      signal
    }) => {
      const requirementId = step.environmentRequirementId
      const environment = requirementId ? restored.get(requirementId) : undefined
      if (!environment) {
        throw new Error(`Reproducibility step has no restored Environment: ${step.stepId}`)
      }
      const execution = executionEnvironment(step, environment, kernelEpochId)
      let helperEpoch = helperEpochs.get(execution.epochKey)
      let helperPlan: Awaited<ReturnType<NotebookHelperModuleHost['plan']>> | undefined
      if (helperModules.length > 0) {
        if (!helperEpoch) {
          const activeById = new Map<string, NotebookHelperModuleEvidence>()
          helperEpoch = {
            ownership: { id: kernelEpochId ?? step.runId, processKey: execution.epochKey },
            activeById,
            host: new NotebookHelperModuleHost({
              resolve: async (id) => {
                const helper = activeById.get(id)
                return helper ? helperDescriptor(helper) : undefined
              }
            })
          }
          helperEpochs.set(execution.epochKey, helperEpoch)
        }
        for (const helper of helperModules) helperEpoch.activeById.set(helper.helperId, helper)
        const request = await helperEpoch.host.preflight(
          step.kernelKind,
          helperModules.map(({ helperId }) => helperId),
          helperEpoch.ownership
        )
        helperPlan = await helperEpoch.host.plan(helperEpoch.ownership, request)
      }
      const dataRoot = join(sessionRoot, 'data')
      const result = await executor.execute({
        ...(step.kernelKind === 'python'
          ? {
              pythonRandomState: validatePythonRandomState(
                executionContext?.before.pythonRandomState
              )
            }
          : {}),
        code:
          step.kernelKind === 'r'
            ? restoreRRandomState(source, executionContext?.before.rRandomState)
            : source,
        ...(helperPlan?.injections.length ? { helperModules: helperPlan.injections } : {}),
        cwd: dataRoot,
        notebookSessionRoot: sessionRoot,
        dataRoot,
        runtimeRoot: join(input.attemptRoot, 'runtime'),
        protectedDirs: [input.storageRoot],
        signal,
        language: step.kernelKind,
        environment: execution.name,
        resolvedInterpreter: {
          command: environment.command,
          condaPrefix: environment.prefix
        },
        sessionId: input.sessionId,
        projectId: input.projectId
      })
      if (helperEpoch) {
        helperEpoch.host.commitInitialized(
          helperEpoch.ownership,
          result.helperModulesInitialized ?? []
        )
      }
      return result
    },
    shutdown: () => executor.shutdown()
  }
}

export { createNotebookReproductionRuntime }
export type {
  CreateNotebookReproductionRuntimeDependencies,
  CreateNotebookReproductionRuntimeInput,
  NotebookReproductionEnvironmentProgress,
  NotebookReproductionEnvironmentOutput,
  NotebookReproductionRuntime,
  NotebookReproductionStep
}
