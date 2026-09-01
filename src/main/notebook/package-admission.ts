import type { NotebookLanguage, NotebookSessionRequest } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeTargetReceipt } from '../../shared/notebook-runtime'
import type { NotebookEnvironmentOperations } from './environment-operations'
import type { EnvironmentCaptureTarget } from './environment-state-tracker'
import { boundedFailureDiagnostic } from './failure-diagnostic'
import type { InstallRequest, InstallResult } from './package-manager'
import type { NotebookRecoveryCoordinator } from './recovery-coordinator'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonReady,
  rReady
} from './runtime-paths'
import { runtimeTargetReceipt } from './runtime-target'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type {
  NotebookSessionAggregate,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'

type PackageAdmissionSession = Pick<NotebookSessionAggregate, 'runtimeBinding'>

type NotebookPackageAdmissionOwnerOptions = {
  runtimeRoot: string
  loadSession: (request: NotebookSessionRequest) => Promise<PackageAdmissionSession>
  findSession: (sessionId: string) => PackageAdmissionSession | undefined
  resolveRuntimeEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>
  isDefaultEnvironmentDisabled: (
    language: NotebookLanguage,
    runtimeRoot: string
  ) => Promise<boolean>
  isAgentEnvironmentCreationEnabled?: () => Promise<boolean>
  repairPolicy: Pick<
    NotebookRuntimeRepairPolicy,
    'blockKey' | 'markerKey' | 'registryKeys' | 'requirement' | 'runtimeId'
  >
  environmentOperations: Pick<NotebookEnvironmentOperations, 'isRepairBlocked'>
  recovery: Pick<
    NotebookRecoveryCoordinator,
    'isGloballyBlocked' | 'isPrefixBlocked' | 'isRuntimeIdBlocked'
  >
  createEnvironmentCaptureTarget: (
    language: NotebookLanguage,
    environmentName: string,
    binding: NotebookSessionRuntimeBinding | undefined,
    resolvedInterpreter: NotebookSessionResolvedInterpreter | undefined,
    runtimeRoot: string
  ) => EnvironmentCaptureTarget
}

type NotebookPackageAdmittedTarget = Readonly<{
  request: InstallRequest
  environmentName: string
  binding?: NotebookSessionRuntimeBinding
  interpreter?: Pick<NotebookSessionResolvedInterpreter, 'command' | 'args' | 'condaPrefix'>
  environmentCaptureTarget: EnvironmentCaptureTarget
  repairRuntimeId: string
  repairMarkerKey: string
  journalTarget?: string
  receipt: RuntimeTargetReceipt
}>

type NotebookPackageRefusal = Readonly<{ status: 'refused'; result: InstallResult }>

type NotebookPackageAdmission =
  NotebookPackageRefusal | Readonly<{ status: 'admitted'; target: NotebookPackageAdmittedTarget }>

type NotebookPackageTargetResolution =
  | Readonly<{
      status: 'resolved'
      binding?: NotebookSessionRuntimeBinding
      environmentName: string
      receipt: RuntimeTargetReceipt
    }>
  | Readonly<{
      status: 'unresolved'
      reason: 'session-unavailable'
      receipt: RuntimeTargetReceipt
    }>
  | Readonly<{
      status: 'unresolved'
      reason: 'target-resolution-failed'
      receipt: RuntimeTargetReceipt
      error: string
    }>

const targetResolutionError = (cause: unknown): string =>
  boundedFailureDiagnostic(cause, {
    prefix: 'RUNTIME_SESSION_UNAVAILABLE: failed to resolve this session and its runtime binding: ',
    fallback: 'the failure value could not be read'
  })

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

const refusal = (
  error: string,
  target: RuntimeTargetReceipt,
  repairRequired = false
): NotebookPackageRefusal => ({
  status: 'refused',
  result: {
    ok: false,
    needsRestart: false,
    ...(repairRequired ? { repairRequired: true } : {}),
    target,
    log: '',
    error
  }
})

/** Owns package target resolution and every fail-closed decision before mutation may begin. */
class NotebookPackageAdmissionOwner {
  constructor(private readonly options: NotebookPackageAdmissionOwnerOptions) {}

  async admit(
    request: InstallRequest,
    resolved?: NotebookPackageTargetResolution
  ): Promise<NotebookPackageAdmission> {
    const resolution = resolved ?? (await this.resolveTarget(request))
    if (resolution.status === 'unresolved') {
      if (resolution.reason === 'target-resolution-failed') {
        return refusal(resolution.error, resolution.receipt)
      }
      return refusal(
        'RUNTIME_SESSION_UNAVAILABLE: cannot resolve this session to honor its runtime binding ' +
          '(no workspaceCwd to load it). Retry with the notebook session context so any bound ' +
          'runtime is applied instead of silently installing into the default environment.',
        resolution.receipt
      )
    }

    const { binding, environmentName, receipt } = resolution
    const runtimeRoot = this.options.runtimeRoot
    const repair = this.options.repairPolicy.requirement(request.language, environmentName, binding)
    const repairRefusal = this.protectedRepairRefusal(
      { request, environmentName, binding },
      repair.protectedIdentity,
      receipt
    )
    if (repairRefusal) return repairRefusal

    let interpreter: NotebookPackageAdmittedTarget['interpreter']
    if (binding?.source === 'external') {
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) return this.unavailable(request.language, binding, receipt)
      if (request.operation === 'uninstall') {
        return refusal(
          'Uninstalling packages from your own environment is disabled. Manage it yourself, or ' +
            'switch to the managed environment.',
          receipt
        )
      }
      const enablement = await this.options.resolveRuntimeEnablement(request.language)
      if (!(enablement?.installAuthorized[binding.runtimeId] ?? false)) {
        return refusal(
          `Installing packages into your own ${request.language} environment is not authorized. ` +
            'Turn on "Allow package install" for this runtime in Settings → Runtimes first (installs ' +
            'go into your own environment, not the app-managed storage).',
          receipt
        )
      }
      if (request.language !== 'python') {
        return refusal(
          'Package management for an external R runtime is not supported yet. Use the managed R ' +
            'environment, or install the package yourself.',
          receipt
        )
      }
      interpreter = binding.resolvedInterpreter
    } else if (binding) {
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) return this.unavailable(request.language, binding, receipt)
    } else if (
      environmentName === defaultEnvironment(request.language) &&
      (await this.options.isDefaultEnvironmentDisabled(request.language, runtimeRoot))
    ) {
      return refusal(
        `No enabled ${request.language} runtime: the app-managed default is disabled and no ` +
          'runtime is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
          'list_notebook_runtimes then notebook_bind_runtime, before installing packages.',
        receipt
      )
    }

    const defaultRuntimeMissing =
      !binding &&
      environmentName === defaultEnvironment(request.language) &&
      (request.language === 'r'
        ? !rReady(runtimeRoot, DEFAULT_ENV_VERSION)
        : !pythonReady(runtimeRoot, DEFAULT_ENV_VERSION))
    if (
      defaultRuntimeMissing &&
      this.options.isAgentEnvironmentCreationEnabled &&
      !(await this.options.isAgentEnvironmentCreationEnabled())
    ) {
      return refusal(
        'AGENT_ENVIRONMENT_CREATION_DISABLED: the Agent cannot prepare a missing Runtime ' +
          'Environment because creation is disabled in Settings → Runtimes.',
        receipt
      )
    }

    const isExternal = binding?.source === 'external'
    const runtimeIdBlocked =
      binding?.runtimeId !== undefined &&
      this.options.recovery.isRuntimeIdBlocked(binding.runtimeId)
    const prefixBlocked =
      !isExternal && this.options.recovery.isPrefixBlocked(envPrefix(runtimeRoot, environmentName))
    const corruptBlockedExternal = isExternal && this.options.recovery.isGloballyBlocked()
    if (runtimeIdBlocked || prefixBlocked || corruptBlockedExternal) {
      return refusal(
        `RUNTIME_RECOVERY_BLOCKED: the ${request.language} environment is recovering from an ` +
          'interrupted operation whose process could not be confirmed stopped. Restart the app to ' +
          're-check and recover it before installing packages.',
        receipt
      )
    }

    const repairRuntimeId = this.options.repairPolicy.runtimeId(environmentName, binding)
    const repairMarkerKey = this.options.repairPolicy.markerKey(
      request.language,
      environmentName,
      binding
    )
    const journalTarget = isExternal ? undefined : envPrefix(runtimeRoot, environmentName)
    return {
      status: 'admitted',
      target: {
        request: { ...request, environment: environmentName },
        environmentName,
        binding,
        interpreter,
        environmentCaptureTarget: this.options.createEnvironmentCaptureTarget(
          request.language,
          environmentName,
          binding,
          binding?.resolvedInterpreter,
          runtimeRoot
        ),
        repairRuntimeId,
        repairMarkerKey,
        journalTarget,
        receipt
      }
    }
  }

  async resolveTarget(request: InstallRequest): Promise<NotebookPackageTargetResolution> {
    if (!request.sessionId) return this.resolvedTarget(request.language)

    try {
      let session: PackageAdmissionSession | undefined
      if (request.workspaceCwd) {
        session = await this.options.loadSession({
          sessionId: request.sessionId,
          workspaceCwd: request.workspaceCwd,
          projectId: request.projectId
        })
      } else {
        session = this.options.findSession(request.sessionId)
      }
      if (!session) {
        return {
          status: 'unresolved',
          reason: 'session-unavailable',
          receipt: { language: request.language, selection: 'unresolved' }
        }
      }
      return this.resolvedTarget(request.language, session)
    } catch (cause) {
      return {
        status: 'unresolved',
        reason: 'target-resolution-failed',
        receipt: { language: request.language, selection: 'unresolved' },
        error: targetResolutionError(cause)
      }
    }
  }

  recheckRepair(
    target: Pick<NotebookPackageAdmittedTarget, 'binding' | 'environmentName' | 'request'>
  ): NotebookPackageRefusal | undefined {
    const { binding, environmentName, request } = target
    const repair = this.options.repairPolicy.requirement(request.language, environmentName, binding)
    return this.protectedRepairRefusal(target, repair.protectedIdentity)
  }

  private protectedRepairRefusal(
    target: Pick<NotebookPackageAdmittedTarget, 'binding' | 'environmentName' | 'request'>,
    protectedIdentity: boolean,
    receipt?: RuntimeTargetReceipt
  ): NotebookPackageRefusal | undefined {
    const { binding, environmentName, request } = target
    if (
      !this.options.environmentOperations.isRepairBlocked(
        this.options.repairPolicy.blockKey(request.language, environmentName, binding)
      ) &&
      !protectedIdentity
    ) {
      return undefined
    }
    return refusal(
      `RUNTIME_REPAIR_REQUIRED: the ${request.language} runtime's protected interpreter identity ` +
        'changed. Use Repair/Reset in Settings → Runtimes to rebuild and verify it before installing ' +
        'packages.',
      receipt ??
        runtimeTargetReceipt({
          runtimeRoot: this.options.runtimeRoot,
          language: request.language,
          selection: binding ? 'explicit-binding' : 'implicit-default',
          binding,
          environmentName
        }),
      true
    )
  }

  private resolvedTarget(
    language: NotebookLanguage,
    session?: PackageAdmissionSession
  ): NotebookPackageTargetResolution {
    const binding = session?.runtimeBinding(language)
    const environmentName =
      binding?.source === 'managed' && binding.envName
        ? binding.envName
        : defaultEnvironment(language)
    return {
      status: 'resolved',
      binding,
      environmentName,
      receipt: runtimeTargetReceipt({
        runtimeRoot: this.options.runtimeRoot,
        language,
        selection: binding ? 'explicit-binding' : 'implicit-default',
        binding,
        environmentName
      })
    }
  }

  private unavailable(
    language: NotebookLanguage,
    binding: NotebookSessionRuntimeBinding,
    receipt: RuntimeTargetReceipt
  ): NotebookPackageAdmission {
    return refusal(
      `RUNTIME_BINDING_UNAVAILABLE: the bound ${language} runtime is ${binding.status}` +
        (binding.reason ? ` (${binding.reason})` : '') +
        '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
        'installing packages.',
      receipt
    )
  }
}

export {
  NotebookPackageAdmissionOwner,
  type NotebookPackageAdmission,
  type NotebookPackageAdmittedTarget,
  type NotebookPackageTargetResolution
}
