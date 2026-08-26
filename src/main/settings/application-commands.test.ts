import { describe, expect, it, vi } from 'vitest'

import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationCommand,
  type ApplicationInvocation
} from '../application-command-router'
import { createWebCallerContext } from '../caller-context'
import {
  registerCoreSettingsApplicationCommands,
  settingsCoreApplicationCommandGroup,
  settingsCoreApplicationCommands,
  type CoreSettingsApplicationCommandDependencies
} from './application-commands'

const expectedChannels = [
  'settings:cancel-claude-login',
  'settings:cancel-codex-login',
  'settings:cancel-isolated-claude-login',
  'settings:check-environment',
  'settings:detect-claude',
  'settings:detect-codex',
  'settings:detect-opencode',
  'settings:get-connector-detail',
  'settings:get-github-token-status',
  'settings:get-package-mirror',
  'settings:get-preflight',
  'settings:get-settings',
  'settings:get-skill-detail',
  'settings:install-claude',
  'settings:install-codex',
  'settings:install-opencode',
  'settings:encryption-available',
  'settings:npm-available',
  'settings:list-app-icons',
  'settings:list-connectors',
  'settings:list-skills',
  'settings:mark-onboarding-complete',
  'settings:preview-agent-home-skill',
  'settings:preview-github-skill',
  'settings:preview-skill-zip',
  'settings:refresh-provider-models',
  'settings:scan-repo-skills',
  'settings:save-github-token',
  'settings:remove-github-token',
  'settings:set-app-icon-variant',
  'settings:set-close-preference',
  'settings:set-default-permission-profile',
  'settings:set-notifications-enabled',
  'settings:set-package-mirror',
  'settings:set-network-proxy',
  'settings:set-project-files-filter',
  'settings:set-reviewer-model',
  'settings:set-session-details-model',
  'settings:set-subagent-model',
  'settings:set-vision-model',
  'settings:validate-provider'
] as const

type CommandArgs<Command> =
  Command extends ApplicationCommand<string, infer Args, unknown> ? Args : never

const callerLease = (): ApplicationCallerLease =>
  Object.freeze({
    leaseId: 'settings-client',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  location: 'local' | 'remote' = 'local'
): ApplicationInvocation<Args> =>
  Object.freeze({
    callerContext: createWebCallerContext('settings-client', { location }),
    callerLease: callerLease(),
    args
  })

const createDependencies = (): Readonly<{
  appearance: ReturnType<typeof vi.fn>
  dependencies: CoreSettingsApplicationCommandDependencies
  emitInstallEvent: ReturnType<typeof vi.fn>
  serviceMethod: (
    name: keyof CoreSettingsApplicationCommandDependencies['service']
  ) => ReturnType<typeof vi.fn>
}> => {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const service = new Proxy(
    {},
    {
      get: (_target, property) => {
        let method = methods.get(property)
        if (!method) {
          method = vi.fn()
          methods.set(property, method)
        }
        return method
      }
    }
  ) as CoreSettingsApplicationCommandDependencies['service']
  const appearance = vi.fn()
  const emitInstallEvent = vi.fn()

  return {
    appearance,
    dependencies: {
      service,
      appearance: { setAppIconVariant: appearance },
      emitInstallEvent,
      listAppIconPreviews: vi.fn(() => [])
    },
    emitInstallEvent,
    serviceMethod: (name) => service[name] as ReturnType<typeof vi.fn>
  }
}

describe('Settings core application commands', () => {
  it('installs the exact 41-command inventory and dispatches a remote-safe preflight query', async () => {
    const { dependencies, serviceMethod } = createDependencies()
    const preflight = { agentReady: true }
    serviceMethod('getPreflight').mockResolvedValue(preflight)
    const router = createApplicationCommandRouter()
    registerCoreSettingsApplicationCommands(router.registrar, dependencies)
    const settingsChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'settings'
    )?.contracts.map((contract) => contract.channel)

    expect(settingsCoreApplicationCommandGroup.commands.map((command) => command.name)).toEqual(
      expectedChannels
    )
    expect(settingsChannels).toEqual(expect.arrayContaining([...expectedChannels]))
    expect(router.dispatcher.commandNames()).toEqual([...expectedChannels].sort())
    await expect(
      router.dispatcher.invoke(
        settingsCoreApplicationCommands.getPreflight,
        invocation([] as const, 'remote')
      )
    ).resolves.toBe(preflight)
    expect(serviceMethod('getPreflight')).toHaveBeenCalledOnce()
  })

  it('delegates canonical requests for every direct remote-safe owner command', async () => {
    const { dependencies, serviceMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerCoreSettingsApplicationCommands(router.registrar, dependencies)
    const invoke = <Command extends keyof typeof settingsCoreApplicationCommands>(
      command: Command,
      args: CommandArgs<(typeof settingsCoreApplicationCommands)[Command]>
    ): Promise<unknown> =>
      router.dispatcher.invoke(settingsCoreApplicationCommands[command], invocation(args, 'remote'))

    await invoke('checkEnvironment', [])
    await invoke('detectClaude', [])
    await invoke('detectCodex', [])
    await invoke('detectOpencode', [])
    await invoke('getConnectorDetail', ['connector-1'])
    await invoke('getPackageMirror', [])
    await invoke('getSettings', [])
    await invoke('getSkillDetail', ['skill-1'])
    await invoke('isEncryptionAvailable', [])
    await invoke('isNpmAvailable', [])
    await invoke('listAppIcons', [])
    await invoke('listConnectors', [])
    await invoke('listSkills', [])
    await invoke('markOnboardingComplete', [])
    await invoke('previewAgentHomeSkill', [{ source: 'agents', slug: 'demo' }])
    await invoke('previewGitHubSkill', [{ url: 'https://github.com/org/repo' }])
    await invoke('previewSkillZip', [{ dataBase64: 'AA==' }])
    await invoke('refreshProviderModels', [{ providerId: 'provider-1' }])
    await invoke('scanRepoSkills', [{ repo: 'org/repo' }])
    await invoke('setReviewerModel', [{ configuration: { mode: 'inherit' } }])
    await invoke('setSessionDetailsModel', [
      { configuration: { mode: 'inherit', reasoningEffort: 'low' } }
    ])
    await invoke('setSubagentModel', [{ configuration: { mode: 'inherit' } }])
    await invoke('validateProvider', [{ providerId: 'provider-1' }])

    expect(serviceMethod('getConnectorDetail')).toHaveBeenCalledWith('connector-1')
    expect(serviceMethod('getSkillDetail')).toHaveBeenCalledWith('skill-1')
    expect(serviceMethod('previewAgentHomeSkill')).toHaveBeenCalledWith({
      source: 'agents',
      slug: 'demo'
    })
    expect(serviceMethod('previewGitHubSkill')).toHaveBeenCalledWith({
      url: 'https://github.com/org/repo'
    })
    expect(serviceMethod('previewSkillZip')).toHaveBeenCalledWith({ dataBase64: 'AA==' })
    expect(serviceMethod('refreshProviderModels')).toHaveBeenCalledWith({
      providerId: 'provider-1'
    })
    expect(serviceMethod('scanRepoSkills')).toHaveBeenCalledWith({ repo: 'org/repo' })
    expect(serviceMethod('setReviewerModel')).toHaveBeenCalledWith({ mode: 'inherit' })
    expect(serviceMethod('setSessionDetailsModel')).toHaveBeenCalledWith({
      mode: 'inherit',
      reasoningEffort: 'low'
    })
    expect(serviceMethod('setSubagentModel')).toHaveBeenCalledWith({ mode: 'inherit' })
    expect(serviceMethod('validateProvider')).toHaveBeenCalledWith({ providerId: 'provider-1' })
  })

  it('rejects all fourteen local-only commands before an owner can run', async () => {
    const { appearance, dependencies, serviceMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerCoreSettingsApplicationCommands(router.registrar, dependencies)

    const attempts = [
      [settingsCoreApplicationCommands.cancelClaudeLogin, []],
      [settingsCoreApplicationCommands.cancelCodexLogin, []],
      [settingsCoreApplicationCommands.cancelIsolatedClaudeLogin, []],
      [settingsCoreApplicationCommands.installClaude, [{ source: 'managed' }]],
      [settingsCoreApplicationCommands.installCodex, [{ source: 'managed' }]],
      [settingsCoreApplicationCommands.installOpencode, [{ source: 'managed' }]],
      [settingsCoreApplicationCommands.getGitHubTokenStatus, []],
      [settingsCoreApplicationCommands.saveGitHubToken, [{ token: 'github_pat_test' }]],
      [settingsCoreApplicationCommands.removeGitHubToken, []],
      [settingsCoreApplicationCommands.setAppIconVariant, [{ variant: 'dark' }]],
      [settingsCoreApplicationCommands.setClosePreference, [{ preference: 'quit' }]],
      [settingsCoreApplicationCommands.setDefaultPermissionProfile, [{ profile: 'auto' }]],
      [settingsCoreApplicationCommands.setNotificationsEnabled, [{ enabled: true }]],
      [settingsCoreApplicationCommands.setPackageMirror, [{}]],
      [settingsCoreApplicationCommands.setNetworkProxy, [{ mode: 'direct' }]]
    ] as const

    for (const [command, args] of attempts) {
      await expect(router.dispatcher.invoke(command, invocation(args, 'remote'))).rejects.toThrow(
        `Channel only available from the local app: ${command.name}`
      )
    }
    expect(serviceMethod('cancelClaudeLogin')).not.toHaveBeenCalled()
    expect(serviceMethod('cancelCodexLogin')).not.toHaveBeenCalled()
    expect(serviceMethod('cancelClaudeIsolatedLogin')).not.toHaveBeenCalled()
    expect(serviceMethod('installClaude')).not.toHaveBeenCalled()
    expect(serviceMethod('installCodex')).not.toHaveBeenCalled()
    expect(serviceMethod('installOpencode')).not.toHaveBeenCalled()
    expect(serviceMethod('getGitHubTokenStatus')).not.toHaveBeenCalled()
    expect(serviceMethod('saveGitHubToken')).not.toHaveBeenCalled()
    expect(serviceMethod('removeGitHubToken')).not.toHaveBeenCalled()
    expect(appearance).not.toHaveBeenCalled()
    expect(serviceMethod('setClosePreference')).not.toHaveBeenCalled()
    expect(serviceMethod('setDefaultPermissionProfile')).not.toHaveBeenCalled()
    expect(serviceMethod('setNotificationsEnabled')).not.toHaveBeenCalled()
    expect(serviceMethod('setPackageMirror')).not.toHaveBeenCalled()
  })

  it('delegates local requests without taking persistence or native-effect ownership', async () => {
    const { appearance, dependencies, emitInstallEvent, serviceMethod } = createDependencies()
    const installEvent = {
      kind: 'log' as const,
      installId: 'install-1',
      stream: 'system' as const,
      chunk: 'started'
    }
    const installProgressEvent = {
      kind: 'progress' as const,
      installId: 'install-1',
      phase: 'download' as const,
      percent: 50
    }
    serviceMethod('installClaude').mockImplementation(async (_request, onEvent) => {
      onEvent(installEvent)
      onEvent(installProgressEvent)
      return { installId: 'install-1', ok: true }
    })
    const router = createApplicationCommandRouter()
    registerCoreSettingsApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.cancelClaudeLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.cancelCodexLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.cancelIsolatedClaudeLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.installClaude,
      invocation([{ source: 'managed' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.installCodex,
      invocation([{ source: 'npm' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.installOpencode,
      invocation([{ source: 'official-script' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.getGitHubTokenStatus,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.saveGitHubToken,
      invocation([{ token: ' github_pat_test ' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.removeGitHubToken,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setAppIconVariant,
      invocation([{ variant: 'dark' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setClosePreference,
      invocation([{}] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setDefaultPermissionProfile,
      invocation([{ profile: 'auto' }] as const)
    )
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setNotificationsEnabled,
      invocation([{ enabled: false }] as const)
    )
    const mirror = { pypiIndex: 'https://pypi.example/simple' }
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setPackageMirror,
      invocation([mirror] as const)
    )

    expect(serviceMethod('cancelClaudeLogin')).toHaveBeenCalledOnce()
    expect(serviceMethod('cancelCodexLogin')).toHaveBeenCalledOnce()
    const networkProxy = { mode: 'direct' as const }
    await router.dispatcher.invoke(
      settingsCoreApplicationCommands.setNetworkProxy,
      invocation([networkProxy] as const)
    )
    expect(serviceMethod('cancelClaudeIsolatedLogin')).toHaveBeenCalledOnce()
    expect(serviceMethod('installClaude')).toHaveBeenCalledWith(
      { source: 'managed' },
      emitInstallEvent
    )
    expect(serviceMethod('installCodex')).toHaveBeenCalledWith({ source: 'npm' }, emitInstallEvent)
    expect(serviceMethod('installOpencode')).toHaveBeenCalledWith(
      { source: 'official-script' },
      emitInstallEvent
    )
    expect(serviceMethod('getGitHubTokenStatus')).toHaveBeenCalledOnce()
    expect(serviceMethod('saveGitHubToken')).toHaveBeenCalledWith('github_pat_test')
    expect(serviceMethod('removeGitHubToken')).toHaveBeenCalledOnce()
    expect(emitInstallEvent.mock.calls.map(([event]) => event)).toEqual([
      installEvent,
      installProgressEvent
    ])
    expect(emitInstallEvent.mock.calls[0]?.[0]).toBe(installEvent)
    expect(emitInstallEvent.mock.calls[1]?.[0]).toBe(installProgressEvent)
    expect(appearance).toHaveBeenCalledWith('dark')
    expect(serviceMethod('setClosePreference')).toHaveBeenCalledWith(undefined)
    expect(serviceMethod('setDefaultPermissionProfile')).toHaveBeenCalledWith('auto')
    expect(serviceMethod('setNotificationsEnabled')).toHaveBeenCalledWith(false)
    expect(serviceMethod('setPackageMirror')).toHaveBeenCalledWith(mirror)
    expect(serviceMethod('setNetworkProxy')).toHaveBeenCalledWith(networkProxy)
  })

  it('preserves exact validation errors before Settings or appearance owners run', async () => {
    const { appearance, dependencies, serviceMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerCoreSettingsApplicationCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        settingsCoreApplicationCommands.setAppIconVariant,
        invocation([{ variant: 'sparkle' } as never] as const)
      )
    ).rejects.toThrow('Unknown app icon variant: sparkle')
    await expect(
      router.dispatcher.invoke(
        settingsCoreApplicationCommands.setClosePreference,
        invocation([{ preference: 'close' } as never] as const)
      )
    ).rejects.toThrow('Invalid close preference: close')
    await expect(
      router.dispatcher.invoke(
        settingsCoreApplicationCommands.setDefaultPermissionProfile,
        invocation([{ profile: 'always' } as never] as const)
      )
    ).rejects.toThrow('Unknown default permission profile: always')
    await expect(
      router.dispatcher.invoke(
        settingsCoreApplicationCommands.setNotificationsEnabled,
        invocation([{ enabled: 'yes' } as never] as const)
      )
    ).rejects.toThrow('Invalid notifications-enabled flag: yes')

    expect(appearance).not.toHaveBeenCalled()
    expect(serviceMethod('setClosePreference')).not.toHaveBeenCalled()
    expect(serviceMethod('setDefaultPermissionProfile')).not.toHaveBeenCalled()
    expect(serviceMethod('setNotificationsEnabled')).not.toHaveBeenCalled()
  })
})
