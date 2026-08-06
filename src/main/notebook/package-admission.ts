import type { NotebookLanguage, NotebookSessionRequest } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import type { NotebookEnvironmentOperations } from './environment-operations'
import type { EnvironmentCaptureTarget } from './environment-state-tracker'
import type { InstallRequest, InstallResult } from './package-manager'
import type { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix } from './runtime-paths'
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
  interpreter?: Pick<NotebookSessionResolvedInterpreter, 'command' | 'args'>
  environmentCaptureTarget: EnvironmentCaptureTarget
  repairRuntimeId: string
  repairMarkerKey: string
  journalTarget?: string
}>

type NotebookPackageRefusal = Readonly<{ status: 'refused'; result: InstallResult }>

type NotebookPackageAdmission =
  NotebookPackageRefusal | Readonly<{ status: 'admitted'; target: NotebookPackageAdmittedTarget }>

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

const refusal = (error: string, repairRequired = false): NotebookPackageRefusal => ({
  status: 'refused',
  result: {
    ok: false,
    needsRestart: false,
    ...(repairRequired ? { repairRequired: true } : {}),
    log: '',
    error
  }
})

/** Owns package target resolution and every fail-closed decision before mutation may begin. */
class NotebookPackageAdmissionOwner {
  constructor(private readonly options: NotebookPackageAdmissionOwnerOptions) {}

  async admit(request: InstallRequest): Promise<NotebookPackageAdmission> {
    const session = await this.resolveSession(request)
    if (session.status === 'refused') return session

    const binding = session.value?.runtimeBinding(request.language)
    const environmentName =
      binding?.source === 'managed' && binding.envName
        ? binding.envName
        : defaultEnvironment(request.language)
    const runtimeRoot = this.options.runtimeRoot
    const repair = this.options.repairPolicy.requirement(request.language, environmentName, binding)
    const repairRefusal = this.protectedRepairRefusal(
      { request, environmentName, binding },
      repair.protectedIdentity
    )
    if (repairRefusal) return repairRefusal

    let interpreter: NotebookPackageAdmittedTarget['interpreter']
    if (binding?.source === 'external') {
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) return this.unavailable(request.language, binding)
      if (request.operation === 'uninstall') {
        return refusal(
          'Uninstalling packages from your own environment is disabled. Manage it yourself, or ' +
            'switch to the managed environment.'
        )
      }
      const enablement = await this.options.resolveRuntimeEnablement(request.language)
      if (!(enablement?.installAuthorized[binding.runtimeId] ?? false)) {
        return refusal(
          `Installing packages into your own ${request.language} environment is not authorized. ` +
            'Turn on "Allow package install" for this runtime in Settings → Runtimes first (installs ' +
            'go into your own environment, not the app-managed storage).'
        )
      }
      if (request.language !== 'python') {
        return refusal(
          'Package management for an external R runtime is not supported yet. Use the managed R ' +
            'environment, or install the package yourself.'
        )
      }
      interpreter = binding.resolvedInterpreter
    } else if (binding) {
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) return this.unavailable(request.language, binding)
    } else if (
      environmentName === defaultEnvironment(request.language) &&
      (await this.options.isDefaultEnvironmentDisabled(request.language, runtimeRoot))
    ) {
      return refusal(
        `No enabled ${request.language} runtime: the app-managed default is disabled and no ` +
          'runtime is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
          'list_notebook_runtimes then notebook_bind_runtime, before installing packages.'
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
          're-check and recover it before installing packages.'
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
        journalTarget
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
    protectedIdentity: boolean
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
      true
    )
  }

  private async resolveSession(
    request: InstallRequest
  ): Promise<
    Readonly<{ status: 'resolved'; value?: PackageAdmissionSession }> | NotebookPackageRefusal
  > {
    if (!request.sessionId) return { status: 'resolved', value: undefined }
    if (request.workspaceCwd) {
      return {
        status: 'resolved',
        value: await this.options.loadSession({
          sessionId: request.sessionId,
          workspaceCwd: request.workspaceCwd,
          projectName: request.projectName
        })
      }
    }
    const session = this.options.findSession(request.sessionId)
    if (session) return { status: 'resolved', value: session }
    return refusal(
      'RUNTIME_SESSION_UNAVAILABLE: cannot resolve this session to honor its runtime binding ' +
        '(no workspaceCwd to load it). Retry with the notebook session context so any bound ' +
        'runtime is applied instead of silently installing into the default environment.'
    )
  }

  private unavailable(
    language: NotebookLanguage,
    binding: NotebookSessionRuntimeBinding
  ): NotebookPackageAdmission {
    return refusal(
      `RUNTIME_BINDING_UNAVAILABLE: the bound ${language} runtime is ${binding.status}` +
        (binding.reason ? ` (${binding.reason})` : '') +
        '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
        'installing packages.'
    )
  }
}

export {
  NotebookPackageAdmissionOwner,
  type NotebookPackageAdmission,
  type NotebookPackageAdmittedTarget
}
