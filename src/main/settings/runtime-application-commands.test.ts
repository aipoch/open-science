import { describe, expect, it, vi } from 'vitest'

import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import { createWebCallerContext } from '../caller-context'
import {
  registerRuntimeSettingsApplicationCommands,
  settingsRuntimeApplicationCommandGroup,
  settingsRuntimeApplicationCommands,
  type RuntimeSettingsApplicationCommandDependencies
} from './runtime-application-commands'
import type { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'

const passThroughSnapshotCommits = {
  currentSnapshotAfter: (pending: Promise<unknown>) => pending,
  projectAfter: (pending: Promise<unknown>) => pending
} as unknown as SettingsSnapshotCommitOwner

const expectedChannels = [
  'settings:uninstall-claude',
  'settings:uninstall-codex',
  'settings:uninstall-codebuddy',
  'settings:uninstall-opencode',
  'settings:upsert-provider',
  'settings:delete-provider',
  'settings:set-active-provider',
  'settings:set-agent-framework',
  'settings:set-agent-routing',
  'settings:set-reasoning-effort',
  'settings:login-shared-claude',
  'settings:logout-shared-claude',
  'settings:login-isolated-claude',
  'settings:login-isolated-claude-browser',
  'settings:logout-isolated-claude',
  'settings:login-isolated-codex',
  'settings:logout-isolated-codex',
  'settings:begin-xai-oauth-login',
  'settings:wait-xai-oauth-login',
  'settings:cancel-xai-oauth-login',
  'settings:logout-xai-oauth'
] as const

const callerLease = (): ApplicationCallerLease =>
  Object.freeze({
    leaseId: 'settings-runtime-client',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  location: 'local' | 'remote' = 'local'
): ApplicationInvocation<Args> =>
  Object.freeze({
    callerContext: createWebCallerContext('settings-runtime-client', { location }),
    callerLease: callerLease(),
    args
  })

const createDependencies = (): Readonly<{
  dependencies: RuntimeSettingsApplicationCommandDependencies
  workflowMethod: (
    name: keyof RuntimeSettingsApplicationCommandDependencies['workflows']
  ) => ReturnType<typeof vi.fn>
}> => {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const workflows = new Proxy(
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
  ) as RuntimeSettingsApplicationCommandDependencies['workflows']

  return {
    dependencies: { workflows, snapshotCommits: passThroughSnapshotCommits },
    workflowMethod: (name) => workflows[name] as ReturnType<typeof vi.fn>
  }
}

describe('Settings runtime application commands', () => {
  it('installs the exact 21-command inventory and keeps Task-only routing off renderer IPC', async () => {
    const { dependencies, workflowMethod } = createDependencies()
    const selected = { activeProviderId: 'provider-1' }
    workflowMethod('setActiveProvider').mockResolvedValue(selected)
    const router = createApplicationCommandRouter()
    registerRuntimeSettingsApplicationCommands(router.registrar, dependencies)
    const settingsChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'settings'
    )?.contracts.map((contract) => contract.channel)

    expect(settingsRuntimeApplicationCommandGroup.commands.map((command) => command.name)).toEqual(
      expectedChannels
    )
    expect(settingsChannels).toEqual(
      expect.arrayContaining(
        expectedChannels.filter((channel) => channel !== 'settings:set-agent-routing')
      )
    )
    expect(settingsChannels).not.toContain('settings:set-agent-routing')
    expect(router.dispatcher.commandNames()).toEqual([...expectedChannels].sort())
    await expect(
      router.dispatcher.invoke(
        settingsRuntimeApplicationCommands.setActiveProvider,
        invocation([{ id: 'provider-1' }] as const, 'remote')
      )
    ).resolves.toBe(selected)
    expect(workflowMethod('setActiveProvider')).toHaveBeenCalledWith({ id: 'provider-1' })
  })

  it('delegates the six remote-safe mutations through the runtime workflow', async () => {
    const { dependencies, workflowMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerRuntimeSettingsApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.upsertProvider,
      invocation([{ type: 'custom', name: 'Provider' }] as const, 'remote')
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.deleteProvider,
      invocation([{ id: 'provider-1', scenarioModelHandling: 'inherit' }] as const, 'remote')
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.setActiveProvider,
      invocation([{ id: 'provider-2', model: 'model-1' }] as const, 'remote')
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.setAgentFramework,
      invocation([{ id: 'opencode' }] as const, 'remote')
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.setAgentRouting,
      invocation(
        [
          {
            framework: 'codex',
            reviewer: { mode: 'inherit' },
            subagent: {
              mode: 'fixed',
              providerId: 'provider-2',
              model: 'model-1',
              reasoningEffort: 'high'
            }
          }
        ] as const,
        'remote'
      )
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.setReasoningEffort,
      invocation([{ effort: 'high' }] as const, 'remote')
    )

    expect(workflowMethod('upsertProvider')).toHaveBeenCalledWith({
      type: 'custom',
      name: 'Provider'
    })
    expect(workflowMethod('deleteProvider')).toHaveBeenCalledWith('provider-1', 'inherit')
    expect(workflowMethod('setActiveProvider')).toHaveBeenCalledWith({
      id: 'provider-2',
      model: 'model-1'
    })
    expect(workflowMethod('setAgentFramework')).toHaveBeenCalledWith({ id: 'opencode' })
    expect(workflowMethod('setAgentRouting')).toHaveBeenCalledWith({
      framework: 'codex',
      reviewer: { mode: 'inherit' },
      subagent: {
        mode: 'fixed',
        providerId: 'provider-2',
        model: 'model-1',
        reasoningEffort: 'high'
      }
    })
    expect(workflowMethod('setReasoningEffort')).toHaveBeenCalledWith({ effort: 'high' })
  })

  it('rejects all fifteen local-only commands before a runtime workflow can run', async () => {
    const { dependencies, workflowMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerRuntimeSettingsApplicationCommands(router.registrar, dependencies)

    const attempts = [
      [settingsRuntimeApplicationCommands.uninstallClaude, []],
      [settingsRuntimeApplicationCommands.uninstallCodex, []],
      [settingsRuntimeApplicationCommands.uninstallCodeBuddy, []],
      [settingsRuntimeApplicationCommands.uninstallOpencode, []],
      [settingsRuntimeApplicationCommands.loginSharedClaude, []],
      [settingsRuntimeApplicationCommands.logoutSharedClaude, []],
      [settingsRuntimeApplicationCommands.loginIsolatedClaude, ['token']],
      [settingsRuntimeApplicationCommands.loginIsolatedClaudeBrowser, []],
      [settingsRuntimeApplicationCommands.logoutIsolatedClaude, []],
      [settingsRuntimeApplicationCommands.loginIsolatedCodex, []],
      [settingsRuntimeApplicationCommands.logoutIsolatedCodex, []],
      [settingsRuntimeApplicationCommands.beginXaiOAuthLogin, []],
      [settingsRuntimeApplicationCommands.waitXaiOAuthLogin, []],
      [settingsRuntimeApplicationCommands.cancelXaiOAuthLogin, []],
      [settingsRuntimeApplicationCommands.logoutXaiOAuth, []]
    ] as const

    for (const [command, args] of attempts) {
      await expect(router.dispatcher.invoke(command, invocation(args, 'remote'))).rejects.toThrow(
        `Channel only available from the local app: ${command.name}`
      )
    }

    expect(workflowMethod('uninstallRuntime')).not.toHaveBeenCalled()
    expect(workflowMethod('loginClaudeShared')).not.toHaveBeenCalled()
    expect(workflowMethod('logoutClaudeShared')).not.toHaveBeenCalled()
    expect(workflowMethod('loginIsolatedClaude')).not.toHaveBeenCalled()
    expect(workflowMethod('loginIsolatedClaudeBrowser')).not.toHaveBeenCalled()
    expect(workflowMethod('logoutIsolatedClaude')).not.toHaveBeenCalled()
    expect(workflowMethod('loginIsolatedCodex')).not.toHaveBeenCalled()
    expect(workflowMethod('logoutIsolatedCodex')).not.toHaveBeenCalled()
    expect(workflowMethod('beginXaiOAuthLogin')).not.toHaveBeenCalled()
    expect(workflowMethod('waitXaiOAuthLogin')).not.toHaveBeenCalled()
    expect(workflowMethod('cancelXaiOAuthLogin')).not.toHaveBeenCalled()
    expect(workflowMethod('logoutXaiOAuth')).not.toHaveBeenCalled()
  })

  it('delegates local runtime and authentication requests without taking effect ownership', async () => {
    const { dependencies, workflowMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerRuntimeSettingsApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.uninstallClaude,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.uninstallCodex,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.uninstallCodeBuddy,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.uninstallOpencode,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.loginSharedClaude,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.logoutSharedClaude,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.loginIsolatedClaude,
      invocation(['token'] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.loginIsolatedClaudeBrowser,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.logoutIsolatedClaude,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.loginIsolatedCodex,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.logoutIsolatedCodex,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.beginXaiOAuthLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.waitXaiOAuthLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.cancelXaiOAuthLogin,
      invocation([] as const)
    )
    await router.dispatcher.invoke(
      settingsRuntimeApplicationCommands.logoutXaiOAuth,
      invocation([] as const)
    )

    expect(workflowMethod('uninstallRuntime').mock.calls).toEqual([
      ['uninstallClaude', 'claude-code'],
      ['uninstallCodex', 'codex'],
      ['uninstallCodeBuddy', 'codebuddy'],
      ['uninstallOpencode', 'opencode']
    ])
    expect(workflowMethod('loginClaudeShared')).toHaveBeenCalledOnce()
    expect(workflowMethod('logoutClaudeShared')).toHaveBeenCalledOnce()
    expect(workflowMethod('loginIsolatedClaude')).toHaveBeenCalledWith('token')
    expect(workflowMethod('loginIsolatedClaudeBrowser')).toHaveBeenCalledOnce()
    expect(workflowMethod('logoutIsolatedClaude')).toHaveBeenCalledOnce()
    expect(workflowMethod('loginIsolatedCodex')).toHaveBeenCalledOnce()
    expect(workflowMethod('logoutIsolatedCodex')).toHaveBeenCalledOnce()
    expect(workflowMethod('beginXaiOAuthLogin')).toHaveBeenCalledOnce()
    expect(workflowMethod('waitXaiOAuthLogin')).toHaveBeenCalledOnce()
    expect(workflowMethod('cancelXaiOAuthLogin')).toHaveBeenCalledOnce()
    expect(workflowMethod('logoutXaiOAuth')).toHaveBeenCalledOnce()
  })

  it('preserves reasoning and isolated-token transport validation before workflow delegation', async () => {
    const { dependencies, workflowMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerRuntimeSettingsApplicationCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        settingsRuntimeApplicationCommands.setReasoningEffort,
        invocation([{ effort: 'ultra' } as never] as const)
      )
    ).rejects.toThrow('Unknown reasoning effort: ultra')
    await expect(
      router.dispatcher.invoke(
        settingsRuntimeApplicationCommands.loginIsolatedClaude,
        invocation([42 as never] as const)
      )
    ).rejects.toThrow('Claude sign-in token must be a string.')

    expect(workflowMethod('setReasoningEffort')).not.toHaveBeenCalled()
    expect(workflowMethod('loginIsolatedClaude')).not.toHaveBeenCalled()
  })
})
