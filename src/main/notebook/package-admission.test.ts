import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { NotebookPackageAdmissionOwner } from './package-admission'
import { envPrefix, managedRepairRegistryKey, repairRegistryPath } from './runtime-paths'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'

type AdmissionOptions = ConstructorParameters<typeof NotebookPackageAdmissionOwner>[0]

const managedBinding = (language: NotebookLanguage = 'python'): NotebookSessionRuntimeBinding => ({
  language,
  runtimeId: `${language}-analysis-id`,
  source: 'managed',
  provenance: 'agent-created',
  interpreterPath: `/runtime/envs/analysis/bin/${language}`,
  label: 'analysis',
  status: 'active',
  envName: 'analysis'
})

const externalBinding = (
  language: NotebookLanguage = 'python',
  overrides: Partial<NotebookSessionRuntimeBinding> = {}
): NotebookSessionRuntimeBinding => ({
  language,
  runtimeId: `${language}-external-id`,
  source: 'external',
  provenance: 'user-own',
  interpreterPath: `/usr/local/bin/${language}`,
  label: `External ${language}`,
  status: 'active',
  resolvedInterpreter: { command: `/usr/local/bin/${language}` },
  ...overrides
})

const ownerHarness = (
  binding: NotebookSessionRuntimeBinding | undefined,
  overrides: Partial<AdmissionOptions> = {}
): {
  owner: NotebookPackageAdmissionOwner
  options: AdmissionOptions
} => {
  const session = { runtimeBinding: vi.fn(() => binding) }
  const runtimeRoot = overrides.runtimeRoot ?? '/runtime'
  const options: AdmissionOptions = {
    runtimeRoot,
    loadSession: vi.fn(async () => session),
    findSession: vi.fn(() => undefined),
    resolveRuntimeEnablement: vi.fn(async () => ({
      enabled: {},
      installAuthorized: binding ? { [binding.runtimeId]: true } : {}
    })),
    isDefaultEnvironmentDisabled: vi.fn(async () => false),
    repairPolicy: new NotebookRuntimeRepairPolicy(runtimeRoot),
    environmentOperations: { isRepairBlocked: vi.fn(() => false) },
    recovery: {
      isGloballyBlocked: vi.fn(() => false),
      isPrefixBlocked: vi.fn(() => false),
      isRuntimeIdBlocked: vi.fn(() => false)
    },
    createEnvironmentCaptureTarget: vi.fn(
      (language, environmentName, selectedBinding, resolvedInterpreter) => ({
        language,
        environmentName,
        runtimeSource:
          selectedBinding?.source === 'external' ? ('external' as const) : ('managed' as const),
        command: resolvedInterpreter?.command ?? `${environmentName}/${language}`
      })
    ),
    ...overrides
  }
  return { owner: new NotebookPackageAdmissionOwner(options), options }
}

describe('NotebookPackageAdmissionOwner', () => {
  it('admits the managed default and pins every mutation target to it', async () => {
    const { owner } = ownerHarness(undefined)

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      environment: 'stale-caller-target'
    })

    expect(admission).toEqual({
      status: 'admitted',
      target: expect.objectContaining({
        request: expect.objectContaining({ environment: 'default-python' }),
        environmentName: 'default-python',
        environmentCaptureTarget: expect.objectContaining({
          environmentName: 'default-python',
          runtimeSource: 'managed'
        }),
        repairRuntimeId: 'default-python',
        repairMarkerKey: managedRepairRegistryKey('default-python', 'python'),
        journalTarget: envPrefix('/runtime', 'default-python')
      })
    })
  })

  it('refuses to lazily create a missing default when Agent creation is disabled', async () => {
    const isAgentEnvironmentCreationEnabled = vi.fn(async () => false)
    const { owner } = ownerHarness(undefined, { isAgentEnvironmentCreationEnabled })

    const admission = await owner.admit({ language: 'python', packages: ['numpy'] })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { error: expect.stringContaining('AGENT_ENVIRONMENT_CREATION_DISABLED') }
    })
    expect(isAgentEnvironmentCreationEnabled).toHaveBeenCalledOnce()
  })

  it('also refuses a missing default selected by an explicit managed binding', async () => {
    const binding: NotebookSessionRuntimeBinding = {
      ...managedBinding(),
      runtimeId: 'default-python-id',
      provenance: 'app-managed',
      label: 'Managed Python',
      envName: 'default-python'
    }
    const { owner } = ownerHarness(binding, {
      isAgentEnvironmentCreationEnabled: vi.fn(async () => false)
    })

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { error: expect.stringContaining('AGENT_ENVIRONMENT_CREATION_DISABLED') }
    })
  })

  it('loads the Session and pins a managed named target instead of trusting the request', async () => {
    const binding = managedBinding()
    const { owner, options } = ownerHarness(binding)

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      projectId: 'project-1',
      environment: 'stale-caller-target'
    })

    expect(options.loadSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      projectId: 'project-1'
    })
    expect(admission).toMatchObject({
      status: 'admitted',
      target: {
        request: { environment: 'analysis' },
        environmentName: 'analysis',
        binding: { runtimeId: binding.runtimeId },
        repairRuntimeId: 'analysis',
        repairMarkerKey: managedRepairRegistryKey('analysis', 'python'),
        journalTarget: envPrefix('/runtime', 'analysis')
      }
    })
  })

  it('admits an authorized external Python interpreter without a managed journal target', async () => {
    const binding = externalBinding()
    const { owner } = ownerHarness(binding)

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(admission).toMatchObject({
      status: 'admitted',
      target: {
        environmentName: 'default-python',
        interpreter: { command: '/usr/local/bin/python' },
        environmentCaptureTarget: { runtimeSource: 'external' },
        repairRuntimeId: binding.runtimeId,
        repairMarkerKey: binding.runtimeId
      }
    })
    expect(admission.status === 'admitted' && admission.target.journalTarget).toBeUndefined()
  })

  it('refuses an unloaded named Session without silently selecting the default', async () => {
    const { owner, options } = ownerHarness(undefined)

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1'
    })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { ok: false, error: expect.stringContaining('RUNTIME_SESSION_UNAVAILABLE') }
    })
    expect(options.loadSession).not.toHaveBeenCalled()
  })

  it('keeps protected identity refusal ahead of binding, authorization and recovery gates', async () => {
    const binding = externalBinding('python', { status: 'unavailable', reason: 'disabled' })
    const resolveRuntimeEnablement = vi.fn(async () => ({
      enabled: {},
      installAuthorized: {}
    }))
    const { owner, options } = ownerHarness(binding, {
      resolveRuntimeEnablement,
      environmentOperations: { isRepairBlocked: vi.fn(() => true) },
      recovery: {
        isGloballyBlocked: vi.fn(() => true),
        isPrefixBlocked: vi.fn(() => true),
        isRuntimeIdBlocked: vi.fn(() => true)
      }
    })

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(admission).toMatchObject({
      status: 'refused',
      result: {
        repairRequired: true,
        error: expect.stringContaining('RUNTIME_REPAIR_REQUIRED')
      }
    })
    expect(resolveRuntimeEnablement).not.toHaveBeenCalled()
    expect(options.recovery.isRuntimeIdBlocked).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'binding unavailable before uninstall',
      binding: externalBinding('python', { status: 'unavailable', reason: 'disabled' }),
      operation: 'uninstall' as const,
      authorized: false,
      error: 'RUNTIME_BINDING_UNAVAILABLE'
    },
    {
      name: 'external uninstall before authorization',
      binding: externalBinding(),
      operation: 'uninstall' as const,
      authorized: false,
      error: 'Uninstalling packages from your own environment is disabled'
    },
    {
      name: 'authorization before unsupported external R',
      binding: externalBinding('r'),
      operation: 'install' as const,
      authorized: false,
      error: 'not authorized'
    },
    {
      name: 'unsupported external R after authorization',
      binding: externalBinding('r'),
      operation: 'install' as const,
      authorized: true,
      error: 'external R runtime is not supported'
    }
  ])('preserves $name refusal ordering', async ({ binding, operation, authorized, error }) => {
    const { owner } = ownerHarness(binding, {
      resolveRuntimeEnablement: vi.fn(async () => ({
        enabled: {},
        installAuthorized: { [binding.runtimeId]: authorized }
      }))
    })

    const admission = await owner.admit({
      language: binding.language,
      packages: ['package'],
      operation,
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { error: expect.stringContaining(error) }
    })
  })

  it('keeps default-disabled refusal ahead of the recovery gate', async () => {
    const { owner, options } = ownerHarness(undefined, {
      isDefaultEnvironmentDisabled: vi.fn(async () => true),
      recovery: {
        isGloballyBlocked: vi.fn(() => true),
        isPrefixBlocked: vi.fn(() => true),
        isRuntimeIdBlocked: vi.fn(() => true)
      }
    })

    const admission = await owner.admit({ language: 'python', packages: ['numpy'] })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { error: expect.stringContaining('No enabled python runtime') }
    })
    expect(options.recovery.isPrefixBlocked).not.toHaveBeenCalled()
  })

  it('refuses an authorized external target blocked by runtime recovery', async () => {
    const binding = externalBinding()
    const { owner } = ownerHarness(binding, {
      recovery: {
        isGloballyBlocked: vi.fn(() => false),
        isPrefixBlocked: vi.fn(() => false),
        isRuntimeIdBlocked: vi.fn(() => true)
      }
    })

    const admission = await owner.admit({
      language: 'python',
      packages: ['numpy'],
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(admission).toMatchObject({
      status: 'refused',
      result: { error: expect.stringContaining('RUNTIME_RECOVERY_BLOCKED') }
    })
  })

  it('does not apply a managed-prefix recovery block to an external target', async () => {
    const binding = externalBinding()
    const isPrefixBlocked = vi.fn(() => true)
    const { owner } = ownerHarness(binding, {
      recovery: {
        isGloballyBlocked: vi.fn(() => false),
        isPrefixBlocked,
        isRuntimeIdBlocked: vi.fn(() => false)
      }
    })

    await expect(
      owner.admit({
        language: 'python',
        packages: ['numpy'],
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
    ).resolves.toMatchObject({ status: 'admitted' })
    expect(isPrefixBlocked).not.toHaveBeenCalled()
  })

  it('treats a legacy managed marker as protected while an external marker stays repairable', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'open-science-package-admission-'))
    const managed = managedBinding()
    const external = externalBinding()
    try {
      mkdirSync(runtimeRoot, { recursive: true })
      writeFileSync(
        repairRegistryPath(runtimeRoot),
        `${JSON.stringify({ runtimeIds: [managed.runtimeId, external.runtimeId] })}\n`,
        'utf8'
      )
      const managedOwner = ownerHarness(managed, {
        runtimeRoot,
        repairPolicy: new NotebookRuntimeRepairPolicy(runtimeRoot)
      }).owner
      const externalOwner = ownerHarness(external, {
        runtimeRoot,
        repairPolicy: new NotebookRuntimeRepairPolicy(runtimeRoot)
      }).owner
      const request = {
        packages: ['package'],
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      }

      await expect(managedOwner.admit({ ...request, language: 'python' })).resolves.toMatchObject({
        status: 'refused',
        result: { error: expect.stringContaining('RUNTIME_REPAIR_REQUIRED') }
      })
      await expect(externalOwner.admit({ ...request, language: 'python' })).resolves.toMatchObject({
        status: 'admitted'
      })
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })
})
