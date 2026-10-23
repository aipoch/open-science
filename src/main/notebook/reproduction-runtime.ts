import { assertRStageReplayPaths } from './r-stage-checkpoint'
import { notebookPromptInputPath } from './prompt-input-materialization'
import type {
  CreateReproductionRuntime,
  NotebookReproductionEnvironmentOutput,
  NotebookReproductionEnvironmentProgress,
  NotebookReproductionStep,
  NotebookReproductionRuntime as ReproductionRuntime
} from '@aipoch/reproducibility'
import {
  restoreRRandomState,
  validatePythonRandomState,
  validRStageCheckpoint
} from '@aipoch/reproducibility'
import type { ArtifactReproducibilityEnvironmentRequirement } from '@aipoch/reproducibility/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveNotebookMicromamba as resolveMicromamba } from './environment-resources'
import type { NotebookSessionExecutionResult } from './session-aggregate'

import {
  CHILD_UNCONFIRMED,
  buildManagedRuntimeProcessEnvironment,
  createFromLockArgv,
  micromambaCacheLockKey,
  micromambaSpawnEnv,
  nativeLockRestoreState,
  normalizeRuntimeArchitecture,
  parseNotebookEnvironmentLock,
  pkgsCache,
  prepareNotebookWorkloadCache,
  pythonBin,
  restoreNativeEnvironmentLock,
  rScriptBin,
  runtimeRoot,
  selectMicromambaCache,
  selectCondaEnvironmentLock,
  condaRuntimeSubsetPlanMatchesLock,
  verifyRestoredEnvironment,
  withSharedCacheLocks
} from '@aipoch/environment'
import type { CondaRuntimeSubsetPlan, NotebookEnvironmentLock } from '@aipoch/environment/contracts'
import type { NotebookHelperModuleEvidence } from '../../shared/notebook'
import { resolveStorageKey, storageKey } from '../artifacts/provenance-storage'
import { runMicromamba, verifyExecutable } from './environment-process'
import { NotebookHelperModuleHost } from './helper-module-host'
import type { NotebookKernelEpochOwnership } from './kernel-epoch-contract'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'
import { resolveLoopScriptPaths } from './runtime-service'
import type { NotebookSessionExecutor } from './session-aggregate'
import { proposeCondaRuntimeSubset, type RRuntimeFootprint } from './reproduction-runtime-subset'

type CreateNotebookReproductionRuntimeInput = Parameters<CreateReproductionRuntime>[0] & {
  storageRoot: string
  processSandbox: NotebookProcessSandbox
  projectId: string
  sessionId: string
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

// Derived locks are new immutable evidence. Never overwrite the source environment lock.
const publishDerivedLock = async (
  storageRoot: string,
  lock: NotebookEnvironmentLock
): Promise<string> => {
  const serialized = `${JSON.stringify(lock, null, 2)}\n`
  const checksum = createHash('sha256').update(serialized).digest('hex')
  const path = environmentLockPath(storageRoot, checksum)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await readFile(path, 'utf8')) !== serialized)
        throw new Error('Immutable derived Environment lock conflict.')
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return checksum
}

const selectedEnvironment = async (
  requirement: ArtifactReproducibilityEnvironmentRequirement,
  lock: NotebookEnvironmentLock,
  input: CreateNotebookReproductionRuntimeInput
): Promise<{
  requirement: ArtifactReproducibilityEnvironmentRequirement
  lock: NotebookEnvironmentLock
}> => {
  // Legacy locks keep their original restoration behavior. New captures can prove the
  // transitive archive closure; loaded namespaces alone cannot prove per-step package use.
  if (
    lock.kernelKind !== 'r' ||
    !lock.components.some(
      (component) => component.ecosystem === 'conda' && component.dependencyGraph
    )
  )
    return { requirement, lock }
  const runs = input.selectedRuns?.filter(
    ({ step }) => step.environmentRequirementId === requirement.requirementId
  )
  if (!runs?.length) return { requirement, lock }
  for (const run of runs) {
    if (createHash('sha256').update(run.source).digest('hex') !== run.step.sourceChecksum)
      throw new Error('Selected reproduction source checksum changed.')
  }
  const roots = new Set(['r-base', 'r-jsonlite'])
  const conda = lock.components.find((component) => component.ecosystem === 'conda')
  const ownership = conda?.dependencyGraph?.rPackageOwnership
  const versions = new Map<string, string>()
  for (const run of runs) {
    const checkpoint = run.stageCheckpoint
    if (checkpoint?.state === 'available') {
      // Validate against the immutable source requirement, before deriving any smaller lock.
      // The checkpoint keeps its original epoch and blob identities throughout restoration.
      if (
        !validRStageCheckpoint(checkpoint) ||
        run.step.kernelKind !== 'r' ||
        checkpoint.runId !== run.step.runId ||
        checkpoint.sourceChecksum !== run.step.sourceChecksum ||
        checkpoint.environmentLockChecksum !== requirement.lockChecksum ||
        !checkpoint.environmentProof ||
        !ownership
      )
        return { requirement, lock }
      for (const pkg of checkpoint.environmentProof.packages) {
        const previous = versions.get(pkg.name)
        if (previous !== undefined && previous !== pkg.version) return { requirement, lock }
        versions.set(pkg.name, pkg.version)
        const owners = ownership.packages.filter((entry) => entry.name === pkg.name)
        if (owners.length !== 1 || owners[0]!.version !== pkg.version) return { requirement, lock }
        roots.add(owners[0]!.condaPackage)
      }
    } else return { requirement, lock }
  }
  const selected = selectCondaEnvironmentLock(lock, [...roots])
  // Reduction is optional; mixed native locks or omission evidence can prevent proving a
  // smaller closure without invalidating the exact source lock validated before selection.
  if (!selected) return { requirement, lock }
  const lockChecksum = await publishDerivedLock(input.storageRoot, selected)
  return { requirement: { ...requirement, lockChecksum }, lock: selected }
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
  index: number,
  runtimeSubset?: CondaRuntimeSubsetPlan
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

  const mm =
    dependencies.micromamba ?? resolveMicromamba({ runtimeRoot: runtimeRoot(input.storageRoot) })
  if (!mm) throw new Error('Micromamba is unavailable for reproducibility execution.')

  const locksRoot = join(input.attemptRoot, 'locks')
  const environmentsRoot = join(input.attemptRoot, 'environments')
  await Promise.all([
    mkdir(locksRoot, { recursive: true, mode: 0o700 }),
    mkdir(environmentsRoot, { recursive: true, mode: 0o700 })
  ])
  const restorationChecksum = runtimeSubset
    ? createHash('sha256').update(JSON.stringify(runtimeSubset)).digest('hex')
    : requirement.lockChecksum
  const lockPath = join(locksRoot, `${restorationChecksum}.lock`)
  await writeFile(lockPath, runtimeSubset?.explicitLock ?? conda.explicitLock, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  const prefix = join(environmentsRoot, restorationChecksum)
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
          compilePyc: requirement.kernelKind !== 'python',
          // A replay must own its executable and libraries. Shared cache inodes can
          // resolve a different prefix (notably R_HOME/libR on macOS), defeating
          // isolation even when the installed archive inventory is correct.
          alwaysCopy: true
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
    ...(runtimeSubset ? { runtimeSubset } : {}),
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
    environmentName: `repro-${restorationChecksum.slice(0, 12)}`,
    prefix,
    command
  }
}

const createNotebookReproductionRuntime = async (
  originalInput: CreateNotebookReproductionRuntimeInput,
  dependencies: CreateNotebookReproductionRuntimeDependencies = {}
): Promise<NotebookReproductionRuntime> => {
  originalInput.signal?.throwIfAborted()
  if (!originalInput.processSandbox.createTemporaryScope) {
    throw new Error('Notebook reproduction requires attempt-owned sandbox temporary resources.')
  }
  const temporaryScope = originalInput.processSandbox.createTemporaryScope(
    join(originalInput.attemptRoot, 'command-temp')
  )
  try {
    return await createScopedNotebookReproductionRuntime(
      { ...originalInput, processSandbox: temporaryScope },
      dependencies,
      temporaryScope
    )
  } catch (error) {
    try {
      await temporaryScope.dispose()
    } catch (cleanupError) {
      throw new Error(
        `${CHILD_UNCONFIRMED}: Reproduction temporary cleanup could not be confirmed; attempt retained.`,
        { cause: new AggregateError([error, cleanupError]) }
      )
    }
    throw error
  }
}

const createScopedNotebookReproductionRuntime = async (
  input: CreateNotebookReproductionRuntimeInput,
  dependencies: CreateNotebookReproductionRuntimeDependencies,
  temporaryScope: NotebookProcessSandbox & { dispose(): Promise<void> }
): Promise<NotebookReproductionRuntime> => {
  input.signal?.throwIfAborted()
  const restored = new Map<string, RestoredEnvironment>()
  const captured: Array<{
    source: ArtifactReproducibilityEnvironmentRequirement
    requirement: ArtifactReproducibilityEnvironmentRequirement
    lock: NotebookEnvironmentLock
    sourceLock: NotebookEnvironmentLock
    runtimeSubset?: CondaRuntimeSubsetPlan
    identity: ReturnType<typeof restoreIdentity>
  }> = []
  if (
    input.runtimeSubset &&
    (!/^[a-f0-9]{64}$/u.test(input.runtimeSubset.scopeChecksum) ||
      input.requirements.length !== 1 ||
      input.requirements[0]?.kernelKind !== 'r' ||
      input.selectedRuns?.length !== 1)
  )
    throw new Error('Runtime subsets require one frozen independent R stage.')
  for (const requirement of input.requirements) {
    input.signal?.throwIfAborted()
    const sourceLock = await loadEnvironmentLock(requirement, input, dependencies)
    if (input.runtimeSubset) {
      const run = input.selectedRuns![0]!
      const checkpoint = run.stageCheckpoint
      if (
        run.step.kernelKind !== 'r' ||
        run.step.environmentRequirementId !== requirement.requirementId ||
        createHash('sha256').update(run.source).digest('hex') !== run.step.sourceChecksum ||
        checkpoint?.state !== 'available' ||
        !validRStageCheckpoint(checkpoint) ||
        !checkpoint.environmentProof ||
        checkpoint.runId !== run.step.runId ||
        checkpoint.sourceChecksum !== run.step.sourceChecksum ||
        checkpoint.environmentLockChecksum !== requirement.lockChecksum
      )
        throw new Error('Runtime subset requires its exact frozen R checkpoint and source.')
    }
    const runtimeSubset = input.runtimeSubset?.plan
    if (
      runtimeSubset &&
      (runtimeSubset.sourceLockChecksum !== requirement.lockChecksum ||
        runtimeSubset.scopeChecksum !== input.runtimeSubset?.scopeChecksum ||
        !condaRuntimeSubsetPlanMatchesLock(runtimeSubset, sourceLock))
    )
      throw new Error('Runtime subset no longer matches its frozen source and scope.')
    const { requirement: selected, lock } = runtimeSubset
      ? { requirement, lock: sourceLock }
      : await selectedEnvironment(requirement, sourceLock, input)
    captured.push({
      source: requirement,
      requirement: selected,
      lock,
      sourceLock,
      ...(runtimeSubset ? { runtimeSubset } : {}),
      identity: runtimeSubset ? JSON.stringify(runtimeSubset) : restoreIdentity(lock)
    })
  }
  const restoredByIdentity = new Map<string, RestoredEnvironment>()
  for (const [index, { requirement, lock, identity, runtimeSubset }] of captured.entries()) {
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
      environment = await restoreEnvironment(
        requirement,
        lock,
        input,
        dependencies,
        index,
        runtimeSubset
      )
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
  let runtimeFootprint: RRuntimeFootprint | undefined
  let shutDown = false

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
    environmentLocks: captured.map(({ source, requirement, runtimeSubset }) => ({
      requirementId: source.requirementId,
      kernelKind: source.kernelKind,
      ...(source.environmentName ? { environmentName: source.environmentName } : {}),
      lockChecksum: requirement.lockChecksum,
      ...(requirement.lockChecksum !== source.lockChecksum
        ? { sourceLockChecksum: source.lockChecksum }
        : {}),
      ...(runtimeSubset
        ? {
            runtimeSubset: {
              schemaVersion: 1 as const,
              scopeChecksum: runtimeSubset.scopeChecksum,
              planChecksum: createHash('sha256')
                .update(JSON.stringify(runtimeSubset))
                .digest('hex'),
              archiveNames: [...runtimeSubset.archiveNames],
              missingDependencies: runtimeSubset.missingDependencies.map((entry) => ({ ...entry }))
            }
          }
        : {})
    })),
    ...(input.runtimeSubset
      ? {
          proposeRuntimeSubset: async () => {
            if (shutDown || !runtimeFootprint || captured.length !== 1) return undefined
            const capture = captured[0]!
            const environment = restored.get(capture.source.requirementId)
            if (!environment) return undefined
            return proposeCondaRuntimeSubset({
              lock: capture.sourceLock,
              sourceLockChecksum: capture.source.lockChecksum,
              scopeChecksum: input.runtimeSubset!.scopeChecksum,
              prefix: environment.prefix,
              footprint: runtimeFootprint,
              platform: dependencies.platform,
              signal: input.signal
            })
          }
        }
      : {}),
    execute: async ({
      step,
      source,
      executionContext,
      sessionRoot,
      kernelEpochId,
      helperModules = [],
      stageRestore,
      stageSupplement,
      stageExpectedOutputPath,
      signal
    }) => {
      const requirementId = step.environmentRequirementId
      const environment = requirementId ? restored.get(requirementId) : undefined
      if (!environment) {
        throw new Error(`Reproducibility step has no restored Environment: ${step.stepId}`)
      }
      if (stageRestore || stageSupplement || stageExpectedOutputPath) {
        if (step.kernelKind !== 'r') throw new Error('Stage checkpoints require an R kernel.')
        await assertRStageReplayPaths(
          sessionRoot,
          step.runId,
          stageRestore,
          stageExpectedOutputPath,
          stageSupplement
        )
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
          step.kernelKind === 'r' && !stageRestore && !stageSupplement && !stageExpectedOutputPath
            ? restoreRRandomState(source, executionContext?.before.rRandomState)
            : source,
        ...(stageRestore ? { stageRestore } : {}),
        ...(stageSupplement ? { stageSupplement } : {}),
        ...(stageExpectedOutputPath ? { stageExpectedOutputPath } : {}),
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
          ...(step.kernelKind === 'r' ? { args: ['--vanilla'] } : {}),
          condaPrefix: environment.prefix
        },
        sessionId: input.sessionId,
        projectId: input.projectId
      })
      if (
        input.runtimeSubset &&
        result.status === 'completed' &&
        result.stageComparison?.outcome === 'equal' &&
        result.stageComparison.runtimeFootprint
      )
        runtimeFootprint = structuredClone(result.stageComparison.runtimeFootprint)
      if (helperEpoch) {
        helperEpoch.host.commitInitialized(
          helperEpoch.ownership,
          result.helperModulesInitialized ?? []
        )
      }
      return result
    },
    shutdown: async () => {
      shutDown = true
      const result = await executor.shutdown()
      if (result.reaped) await temporaryScope.dispose()
      return result
    }
  }
}

export { createNotebookReproductionRuntime }
export type {
  CreateNotebookReproductionRuntimeDependencies,
  CreateNotebookReproductionRuntimeInput,
  NotebookReproductionEnvironmentOutput,
  NotebookReproductionEnvironmentProgress,
  NotebookReproductionRuntime,
  NotebookReproductionStep
}

import {
  createReproductionExecutor,
  createWorkflowSliceExecutor,
  type ExecuteWorkflowSliceInput,
  type ExecuteArtifactReproducibilityDependencies,
  type ExecuteArtifactReproducibilityInput
} from '@aipoch/reproducibility'
import {
  reproductionEvidence,
  reproductionRecipes,
  runtimeSubsetCandidateStore
} from '../artifacts/reproducibility-host'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
const executeReproduction = createReproductionExecutor({
  recipes: reproductionRecipes,
  fileIO: { copyFile: copyFileWithinBudget, digestFile: digestFileWithinBudget }
})
export type HostReproductionInput = Omit<ExecuteArtifactReproducibilityInput, 'evidence'> & {
  storageRoot: string
  processSandbox: NotebookProcessSandbox
}
export type HostReproductionDependencies = Omit<
  ExecuteArtifactReproducibilityDependencies,
  'createRuntime'
> & {
  createRuntime?: typeof createNotebookReproductionRuntime
  runtimeSubsetConformance?: false
  // Explicit certification input, never supplied by the renderer. It remains an
  // untrusted candidate until the normal production replay verifies it.
  runtimeSubsetCandidate?: CondaRuntimeSubsetPlan
}

// This adapter composes existing Notebook ownership, product identity and sandbox policy.
// The caller retains authorization, storage leases and receipt publication/SQL transactions.
export const executeArtifactReproducibility = (
  input: HostReproductionInput,
  dependencies: HostReproductionDependencies = {}
): ReturnType<typeof executeReproduction> => {
  const { storageRoot, processSandbox, ...attempt } = input
  return executeReproduction(
    { ...attempt, evidence: reproductionEvidence(storageRoot) },
    {
      createAttemptRoot: dependencies.createAttemptRoot,
      createRuntime: (runtime) =>
        (dependencies.createRuntime ?? createNotebookReproductionRuntime)({
          ...runtime,
          storageRoot,
          processSandbox,
          projectId: 'artifact-reproducibility',
          sessionId: 'reproduction-' + input.execution.reproducibilityRecipe!.recipeId.slice(0, 16)
        })
    }
  )
}

// Host callers may inspect kernel outputs; replay needs only the base execution result.
type NotebookReproductionRuntime = Omit<ReproductionRuntime, 'execute'> & {
  execute(
    input: Parameters<ReproductionRuntime['execute']>[0]
  ): Promise<NotebookSessionExecutionResult>
}

const executeWorkflow = createWorkflowSliceExecutor({
  inputPath: notebookPromptInputPath,
  fileIO: { copyFile: copyFileWithinBudget, digestFile: digestFileWithinBudget }
})
export type HostWorkflowReproductionInput = Omit<ExecuteWorkflowSliceInput, 'evidence'> & {
  storageRoot: string
  processSandbox: NotebookProcessSandbox
}
export const executeWorkflowReproducibility = async (
  input: HostWorkflowReproductionInput,
  dependencies: HostReproductionDependencies = {}
): ReturnType<typeof executeWorkflow> => {
  const { storageRoot, processSandbox, ...attempt } = input
  const candidates = runtimeSubsetCandidateStore(storageRoot)
  let claimed: Awaited<ReturnType<typeof candidates.claim>> | undefined
  let returnPreviousHint = false
  try {
    return await executeWorkflow(
      { ...attempt, evidence: reproductionEvidence(storageRoot) },
      {
        createAttemptRoot: dependencies.createAttemptRoot,
        ...(dependencies.runtimeSubsetConformance === false
          ? {}
          : {
              runtimeSubsetContextChecksum: createHash('sha256')
                .update(
                  JSON.stringify([
                    // Bump when execution, restore verification or native observation
                    // rules change; persistent hints cannot cross implementation revisions.
                    'runtime-subset-hints-v2',
                    storageRoot,
                    process.platform,
                    process.arch,
                    createHash('sha256')
                      .update(await readFile(resolveLoopScriptPaths().rLoopPath))
                      .digest('hex')
                  ])
                )
                .digest('hex'),
              loadRuntimeSubsetCandidate: async (
                scopeChecksum: string,
                sourceLockChecksum: string
              ) => {
                const seed = dependencies.runtimeSubsetCandidate
                if (seed?.sourceLockChecksum === sourceLockChecksum)
                  return { ...structuredClone(seed), scopeChecksum }
                claimed = await candidates.claim(scopeChecksum)
                return claimed.candidate
              },
              restoreCancelledRuntimeSubsetCandidate: async () => {
                returnPreviousHint = true
              },
              saveRuntimeSubsetCandidate: (candidate: CondaRuntimeSubsetPlan) =>
                candidates.save(candidate)
            }),
        createRuntime: (runtime) =>
          (dependencies.createRuntime ?? createNotebookReproductionRuntime)({
            ...runtime,
            storageRoot,
            processSandbox,
            projectId: 'artifact-reproducibility',
            sessionId: 'workflow-' + input.plan.planId.slice(0, 16)
          })
      }
    )
  } finally {
    // A clean cancellation may return only the previously stored hint. A new
    // certification seed has no claim and cannot publish through this path.
    await claimed?.release(returnPreviousHint).catch(() => undefined)
  }
}
