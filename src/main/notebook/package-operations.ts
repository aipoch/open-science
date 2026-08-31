import type { NotebookLanguage, NotebookSessionRequest } from '../../shared/notebook'
import type { PackageMirror } from '../../shared/mirror'
import type { RuntimeEnablement, RuntimeTargetReceipt } from '../../shared/notebook-runtime'
import type { NotebookEnvironmentOperations } from './environment-operations'
import type {
  EnvironmentCaptureTarget,
  EnvironmentStateTracker,
  PackageInspectionResult
} from './environment-state-tracker'
import { boundedFailureDiagnostic } from './failure-diagnostic'
import { effectiveMirrorAsync, type ProbeDeps } from './mirror-probe'
import { NotebookPackageAdmissionOwner } from './package-admission'
import type { NotebookPackageAdmittedTarget } from './package-admission'
import type { InstallDeps, InstallRequest, InstallResult, InstallSpawn } from './package-manager'
import type { MicromambaWorkingCacheRetainer } from './windows-micromamba-working-cache'
import { NotebookPackageMutationOwner } from './package-mutation'
import type { NotebookRecoveryCoordinator } from './recovery-coordinator'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonReady,
  rReady
} from './runtime-paths'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type { MicromambaRunner } from './windows-micromamba-runner'
import type {
  NotebookSessionAggregate,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'

type InspectPackagesRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  packages: string[]
}

type InspectPackagesResult = PackageInspectionResult & {
  language: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  runtimeId?: string
  runtimeLabel?: string
}

type PackageSession = NotebookSessionAggregate

type NotebookPackageOperationsOptions = {
  storageRoot: string
  runtimeRoot: string
  locale: string
  mirrorProbe?: ProbeDeps
  resolvePackageMirror?: () => PackageMirror | undefined | Promise<PackageMirror | undefined>
  ensureRecovered: () => Promise<void>
  loadSession: (request: NotebookSessionRequest) => Promise<PackageSession>
  findSession: (sessionId: string) => PackageSession | undefined
  sessions: () => Iterable<PackageSession>
  notifyChanged: (session: PackageSession) => void
  resolveRuntimeEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>
  isDefaultEnvironmentDisabled: (
    language: NotebookLanguage,
    runtimeRoot: string
  ) => Promise<boolean>
  repairPolicy: NotebookRuntimeRepairPolicy
  runtimeRepair: Pick<
    NotebookRuntimeRepairOwner,
    'quarantineProtectedIdentity' | 'completeInterruptedInstall'
  >
  recovery: Pick<
    NotebookRecoveryCoordinator,
    | 'isGloballyBlocked'
    | 'isPrefixBlocked'
    | 'isRuntimeIdBlocked'
    | 'markLiveUnconfirmed'
    | 'markRuntimeLiveUnconfirmed'
  >
  environmentOperations: Pick<
    NotebookEnvironmentOperations,
    | 'isRepairBlocked'
    | 'logPackageFailure'
    | 'logPackageResult'
    | 'recommendRestart'
    | 'runMutation'
    | 'runShared'
  >
  environmentStateTracker: Pick<
    EnvironmentStateTracker,
    'inspectPackages' | 'markPackageMutationDirty' | 'refreshAfterPackageMutation'
  >
  installPackages: (request: InstallRequest, deps?: Partial<InstallDeps>) => Promise<InstallResult>
  packageSpawn?: (target: NotebookPackageAdmittedTarget) => InstallSpawn
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  retainWorkingCache?: MicromambaWorkingCacheRetainer
  createEnvironmentCaptureTarget: (
    language: NotebookLanguage,
    environmentName: string,
    binding: NotebookSessionRuntimeBinding | undefined,
    resolvedInterpreter: NotebookSessionResolvedInterpreter | undefined,
    runtimeRoot: string
  ) => EnvironmentCaptureTarget
}

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

const packageOperationFailure = (error: unknown, target: RuntimeTargetReceipt): InstallResult => {
  return {
    ok: false,
    needsRestart: false,
    log: '',
    target,
    error: boundedFailureDiagnostic(error, {
      fallback: 'Package operation failed with an unreadable error.'
    })
  }
}

/** Composes package inspection and mutation behind two stable operations. */
class NotebookPackageOperations {
  private readonly admission: NotebookPackageAdmissionOwner
  private readonly mutation: NotebookPackageMutationOwner

  constructor(private readonly options: NotebookPackageOperationsOptions) {
    this.admission = new NotebookPackageAdmissionOwner({
      runtimeRoot: options.runtimeRoot,
      loadSession: options.loadSession,
      findSession: options.findSession,
      resolveRuntimeEnablement: options.resolveRuntimeEnablement,
      isDefaultEnvironmentDisabled: options.isDefaultEnvironmentDisabled,
      repairPolicy: options.repairPolicy,
      environmentOperations: options.environmentOperations,
      recovery: options.recovery,
      createEnvironmentCaptureTarget: options.createEnvironmentCaptureTarget
    })
    this.mutation = new NotebookPackageMutationOwner({
      storageRoot: options.storageRoot,
      runtimeRoot: options.runtimeRoot,
      environmentOperations: options.environmentOperations,
      environmentStateTracker: options.environmentStateTracker,
      installPackages: options.installPackages,
      ...(options.packageSpawn ? { packageSpawn: options.packageSpawn } : {}),
      micromambaRunner: options.micromambaRunner,
      retainWorkingCache: options.retainWorkingCache,
      recheckRepair: (target) => this.admission.recheckRepair(target),
      runtimeRepair: options.runtimeRepair,
      blockUnconfirmedChild: ({ repairRuntimeId, journalTarget }) => {
        options.recovery.markRuntimeLiveUnconfirmed(repairRuntimeId)
        if (journalTarget) options.recovery.markLiveUnconfirmed(journalTarget)
      }
    })
  }

  async inspect(request: InspectPackagesRequest): Promise<InspectPackagesResult> {
    await this.options.ensureRecovered()
    const session = await this.options.loadSession(request)
    const binding = session.runtimeBinding(request.language)
    const environmentName =
      binding?.source === 'managed' && binding.envName
        ? binding.envName
        : defaultEnvironment(request.language)
    const isExternal = binding?.source === 'external'
    if (isExternal) {
      throw new Error(
        'EXTERNAL_RUNTIME_INSPECTION_REQUIRES_EXECUTION: inspect_packages cannot run a bound ' +
          'external interpreter under package-metadata permission. Use notebook_execute in this ' +
          'runtime to query package metadata so interpreter execution receives notebook approval.'
      )
    }
    if (
      (binding?.runtimeId && this.options.recovery.isRuntimeIdBlocked(binding.runtimeId)) ||
      this.options.recovery.isPrefixBlocked(envPrefix(this.options.runtimeRoot, environmentName)) ||
      (isExternal && this.options.recovery.isGloballyBlocked())
    ) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: the ${request.language} environment is recovering from an ` +
          'interrupted operation whose process could not be confirmed stopped. Restart the app to ' +
          're-check and recover it before inspecting packages.'
      )
    }
    if (binding && (binding.status ?? 'active') !== 'active') {
      throw new Error(
        `RUNTIME_BINDING_UNAVAILABLE: the bound ${request.language} runtime is ${binding.status}` +
          (binding.reason ? ` (${binding.reason})` : '') +
          '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
          'inspecting packages.'
      )
    }
    if (
      !binding &&
      (await this.options.isDefaultEnvironmentDisabled(request.language, this.options.runtimeRoot))
    ) {
      throw new Error(
        `No enabled ${request.language} runtime: the app-managed default is disabled and no runtime ` +
          'is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
          'list_notebook_runtimes then notebook_bind_runtime, before inspecting packages.'
      )
    }

    const isDefaultEnvironment = environmentName === defaultEnvironment(request.language)
    const isDefaultReady =
      request.language === 'r'
        ? rReady(this.options.runtimeRoot, DEFAULT_ENV_VERSION)
        : pythonReady(this.options.runtimeRoot, DEFAULT_ENV_VERSION)
    if (isDefaultEnvironment && !isDefaultReady) {
      throw new Error(
        `DEFAULT_RUNTIME_NOT_READY: the app-managed ${request.language} runtime is not prepared, and ` +
          'inspect_packages cannot create it under read-only package-metadata permission. Use ' +
          `notebook_execute with language "${request.language}" to prepare the runtime under notebook ` +
          'execution approval, then retry inspect_packages.'
      )
    }

    const target = this.options.createEnvironmentCaptureTarget(
      request.language,
      environmentName,
      binding,
      binding?.resolvedInterpreter,
      this.options.runtimeRoot
    )
    const inspection = await this.options.environmentOperations.runShared(
      'inspection',
      environmentName,
      () => this.options.environmentStateTracker.inspectPackages(target, request.packages)
    )
    return {
      language: request.language,
      environmentName,
      runtimeSource: target.runtimeSource,
      ...(binding?.runtimeId ? { runtimeId: binding.runtimeId } : {}),
      ...(binding?.label ? { runtimeLabel: binding.label } : {}),
      ...inspection
    }
  }

  async manage(request: InstallRequest): Promise<InstallResult> {
    const resolution = await this.admission.resolveTarget(request)
    try {
      await this.options.ensureRecovered()
      const mirror = await effectiveMirrorAsync(
        await this.resolvePackageMirror(),
        this.options.locale,
        this.options.mirrorProbe
      )
      const admission = await this.admission.admit(request, resolution)
      if (admission.status === 'refused') return admission.result
      const result = await this.mutation.mutate({ target: admission.target, mirror })
      if (result.ok && result.needsRestart && request.language === 'r') {
        this.options.environmentOperations.recommendRestart('r', admission.target.environmentName)
        for (const session of this.options.sessions()) this.options.notifyChanged(session)
      }
      const environmentName =
        admission.target.binding?.source === 'external'
          ? (admission.target.binding.label ?? admission.target.environmentName)
          : admission.target.environmentName
      return { ...result, environmentName, target: admission.target.receipt }
    } catch (error) {
      return packageOperationFailure(error, resolution.receipt)
    }
  }

  private async resolvePackageMirror(): Promise<PackageMirror | undefined> {
    try {
      return await this.options.resolvePackageMirror?.()
    } catch {
      return undefined
    }
  }
}

export { NotebookPackageOperations, type InspectPackagesRequest, type InspectPackagesResult }
