import { describe, expect, it, vi } from 'vitest'

import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import {
  createCallerContext,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  type CallerContext
} from '../caller-context'
import { ApprovalBroker } from '../connectors/approval-broker'
import {
  SkillImportApprovalBroker,
  type SkillImportApprovalInfo
} from '../skills/conversation-import'
import {
  registerIntegrationSettingsApplicationCommands,
  settingsApprovalApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsIntegrationApplicationCommands,
  settingsSkillApplicationCommandGroup,
  type IntegrationSettingsApplicationCommandDependencies
} from './integration-application-commands'
import type { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'

const passThroughSnapshotCommits = {
  currentSnapshotAfter: (pending: Promise<unknown>) => pending,
  projectAfter: (pending: Promise<unknown>) => pending
} as unknown as SettingsSnapshotCommitOwner

const expectedSkillChannels = [
  'settings:set-conversation-skill-import-enabled',
  'settings:set-skill-enabled',
  'settings:set-skills-enabled',
  'settings:create-skill',
  'settings:update-skill',
  'settings:delete-skill',
  'settings:import-skill',
  'settings:import-skill-zip',
  'settings:import-skill-zip-batch'
] as const

const expectedConnectorChannels = [
  'settings:list-device-credentials',
  'settings:create-device-credential',
  'settings:update-device-credential',
  'settings:remove-device-credential',
  'settings:authenticate-device-credential',
  'settings:cancel-device-credential-authentication',
  'settings:disconnect-device-credential',
  'settings:set-connector-enabled',
  'settings:set-connector-auto-allow',
  'settings:set-tool-permission',
  'settings:set-ncbi-credentials',
  'settings:set-openalex-credential',
  'settings:validate-openalex-credential',
  'settings:add-custom-server',
  'settings:set-custom-server-enabled',
  'settings:remove-custom-server',
  'settings:update-custom-server',
  'settings:authenticate-custom-server',
  'settings:cancel-custom-server-authentication',
  'settings:disconnect-custom-server',
  'settings:retry-custom-server'
] as const

const expectedApprovalChannels = [
  'connectors:approval-respond',
  'connectors:approval-replay',
  'connectors:approval-replay-pending',
  'skills:conversation-import-respond',
  'skills:conversation-import-replay-pending'
] as const

const callerLease = (leaseId = 'settings-integration-client'): ApplicationCallerLease =>
  Object.freeze({
    leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  callerContext: CallerContext = createWebCallerContext('settings-integration-client', {
    location: 'remote'
  })
): ApplicationInvocation<Args> =>
  Object.freeze({
    callerContext,
    callerLease: callerLease(callerContext.leaseId),
    args
  })

const createMethodPort = <Port extends object>(): Readonly<{
  port: Port
  method: (name: keyof Port) => ReturnType<typeof vi.fn>
}> => {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const port = new Proxy(
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
  ) as Port

  return { port, method: (name) => port[name] as ReturnType<typeof vi.fn> }
}

const createDependencies = (): Readonly<{
  dependencies: IntegrationSettingsApplicationCommandDependencies
  skillMethod: (
    name: keyof IntegrationSettingsApplicationCommandDependencies['skills']
  ) => ReturnType<typeof vi.fn>
  connectorMethod: (
    name: keyof IntegrationSettingsApplicationCommandDependencies['connectors']
  ) => ReturnType<typeof vi.fn>
}> => {
  const skills = createMethodPort<IntegrationSettingsApplicationCommandDependencies['skills']>()
  const connectors =
    createMethodPort<IntegrationSettingsApplicationCommandDependencies['connectors']>()

  return {
    dependencies: {
      skills: skills.port,
      connectors: connectors.port,
      snapshotCommits: passThroughSnapshotCommits,
      connectorApprovals: {
        getPending: vi.fn(() => null),
        replayPending: vi.fn(),
        respond: vi.fn()
      },
      skillImportApprovals: { respond: vi.fn(), replayPending: vi.fn() }
    },
    skillMethod: skills.method,
    connectorMethod: connectors.method
  }
}

describe('Settings integration application commands', () => {
  it('defines the exact 35-command Skill, Connector, and approval inventory', () => {
    const groups = [
      settingsSkillApplicationCommandGroup,
      settingsConnectorApplicationCommandGroup,
      settingsApprovalApplicationCommandGroup
    ]
    const settingsChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'settings'
    )?.contracts.map((contract) => contract.channel)
    const expectedChannels = [
      ...expectedSkillChannels,
      ...expectedConnectorChannels,
      ...expectedApprovalChannels
    ]
    const integrationContracts = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'settings'
    )?.contracts.filter((contract) =>
      expectedChannels.includes(contract.channel as (typeof expectedChannels)[number])
    )
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(
      router.registrar,
      createDependencies().dependencies
    )

    expect(settingsSkillApplicationCommandGroup.commands.map((command) => command.name)).toEqual(
      expectedSkillChannels
    )
    expect(
      settingsConnectorApplicationCommandGroup.commands.map((command) => command.name)
    ).toEqual(expectedConnectorChannels)
    expect(settingsApprovalApplicationCommandGroup.commands.map((command) => command.name)).toEqual(
      expectedApprovalChannels
    )
    expect(groups.reduce((count, group) => count + group.commands.length, 0)).toBe(35)
    expect(router.dispatcher.commandNames()).toEqual([...expectedChannels].sort())
    expect(settingsChannels).toEqual(
      expect.arrayContaining([
        ...expectedSkillChannels,
        ...expectedConnectorChannels,
        ...expectedApprovalChannels
      ])
    )
    expect(integrationContracts).toHaveLength(35)
    expect(
      integrationContracts
        ?.filter(
          (contract) =>
            contract.channel !== 'settings:authenticate-custom-server' &&
            contract.channel !== 'settings:cancel-custom-server-authentication' &&
            contract.channel !== 'settings:disconnect-custom-server' &&
            contract.channel !== 'settings:retry-custom-server' &&
            contract.channel !== 'settings:list-device-credentials' &&
            contract.channel !== 'settings:create-device-credential' &&
            contract.channel !== 'settings:update-device-credential' &&
            contract.channel !== 'settings:remove-device-credential' &&
            contract.channel !== 'settings:authenticate-device-credential' &&
            contract.channel !== 'settings:cancel-device-credential-authentication' &&
            contract.channel !== 'settings:disconnect-device-credential' &&
            contract.channel !== 'settings:set-openalex-credential' &&
            contract.channel !== 'settings:validate-openalex-credential' &&
            contract.channel !== 'settings:add-custom-server' &&
            contract.channel !== 'settings:set-custom-server-enabled' &&
            contract.channel !== 'settings:remove-custom-server' &&
            contract.channel !== 'settings:update-custom-server'
        )
        .every(
          (contract) =>
            contract.kind === 'method' &&
            contract.surfaceInstallation.localWeb === 'web-rpc' &&
            contract.surfaceInstallation.remoteWeb === 'web-rpc'
        )
    ).toBe(true)
    expect(
      integrationContracts
        ?.filter(
          (contract) =>
            contract.channel === 'settings:authenticate-custom-server' ||
            contract.channel === 'settings:cancel-custom-server-authentication' ||
            contract.channel === 'settings:disconnect-custom-server' ||
            contract.channel === 'settings:retry-custom-server' ||
            contract.channel === 'settings:list-device-credentials' ||
            contract.channel === 'settings:create-device-credential' ||
            contract.channel === 'settings:update-device-credential' ||
            contract.channel === 'settings:remove-device-credential' ||
            contract.channel === 'settings:authenticate-device-credential' ||
            contract.channel === 'settings:cancel-device-credential-authentication' ||
            contract.channel === 'settings:disconnect-device-credential' ||
            contract.channel === 'settings:set-openalex-credential' ||
            contract.channel === 'settings:validate-openalex-credential' ||
            contract.channel === 'settings:add-custom-server' ||
            contract.channel === 'settings:set-custom-server-enabled' ||
            contract.channel === 'settings:remove-custom-server' ||
            contract.channel === 'settings:update-custom-server'
        )
        .every(
          (contract) =>
            contract.surfaceInstallation.localWeb === 'web-rpc' &&
            contract.surfaceInstallation.remoteWeb === 'rejecting-stub'
        )
    ).toBe(true)
    for (const eventChannel of [
      'connectors:approval-request',
      'settings:install-log',
      'skills:conversation-import-request',
      'skills:conversation-import-settled'
    ]) {
      expect(router.dispatcher.commandNames()).not.toContain(eventChannel)
    }
  })

  it('delegates all nine remote Skill mutations through the Skill workflow owner', async () => {
    const { dependencies, skillMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setConversationSkillImportEnabled,
      invocation([{ enabled: true }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setSkillEnabled,
      invocation([{ id: 'skill-1', enabled: false }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setSkillsEnabled,
      invocation([{ ids: ['skill-1', 'skill-2'], enabled: false }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.createSkill,
      invocation([{ name: 'Skill', description: 'Description', body: 'Body' }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.updateSkill,
      invocation([
        { id: 'personal-skill', name: 'Skill', description: 'Updated', body: 'Body' }
      ] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.deleteSkill,
      invocation([{ id: 'personal-skill' }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.importSkill,
      invocation([{ url: 'https://github.com/org/repo/tree/main/skill' }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.importSkillZip,
      invocation([{ dataBase64: 'AA==', filename: 'skill.zip' }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.importSkillZipBatch,
      invocation([{ dataBase64: 'AA==', items: [{ subPath: 'skill' }] }] as const)
    )

    expect(skillMethod('setConversationSkillImportEnabled')).toHaveBeenCalledWith({ enabled: true })
    expect(skillMethod('setSkillEnabled')).toHaveBeenCalledWith({
      id: 'skill-1',
      enabled: false
    })
    expect(skillMethod('setSkillsEnabled')).toHaveBeenCalledWith({
      ids: ['skill-1', 'skill-2'],
      enabled: false
    })
    expect(skillMethod('createSkill')).toHaveBeenCalledWith({
      name: 'Skill',
      description: 'Description',
      body: 'Body'
    })
    expect(skillMethod('updateSkill')).toHaveBeenCalledWith({
      id: 'personal-skill',
      name: 'Skill',
      description: 'Updated',
      body: 'Body'
    })
    expect(skillMethod('deleteSkill')).toHaveBeenCalledWith({ id: 'personal-skill' })
    expect(skillMethod('importSkill')).toHaveBeenCalledWith({
      url: 'https://github.com/org/repo/tree/main/skill'
    })
    expect(skillMethod('importSkillZip')).toHaveBeenCalledWith({
      dataBase64: 'AA==',
      filename: 'skill.zip'
    })
    expect(skillMethod('importSkillZipBatch')).toHaveBeenCalledWith({
      dataBase64: 'AA==',
      items: [{ subPath: 'skill' }]
    })
  })

  it('preserves conversation Skill-import validation before workflow delegation', async () => {
    const { dependencies, skillMethod } = createDependencies()
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.setConversationSkillImportEnabled,
        invocation([{ enabled: 'yes' } as never] as const)
      )
    ).rejects.toThrow('Invalid conversation-skill-import-enabled flag: yes')
    expect(skillMethod('setConversationSkillImportEnabled')).not.toHaveBeenCalled()
  })

  it('delegates all four remotely available Connector mutations through the workflow owner', async () => {
    const { connectorMethod, dependencies } = createDependencies()
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setConnectorEnabled,
      invocation([{ id: 'pubchem', enabled: false }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setConnectorAutoAllow,
      invocation([{ id: 'pubchem', autoAllow: true }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setToolPermission,
      invocation([{ toolId: 'pubchem/search', permission: 'allow' }] as const)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setNcbiCredentials,
      invocation([{ contactEmail: 'researcher@example.test', apiKey: 'secret' }] as const)
    )
    expect(connectorMethod('setConnectorEnabled')).toHaveBeenCalledWith({
      id: 'pubchem',
      enabled: false
    })
    expect(connectorMethod('setConnectorAutoAllow')).toHaveBeenCalledWith({
      id: 'pubchem',
      autoAllow: true
    })
    expect(connectorMethod('setToolPermission')).toHaveBeenCalledWith({
      toolId: 'pubchem/search',
      permission: 'allow'
    })
    expect(connectorMethod('setNcbiCredentials')).toHaveBeenCalledWith({
      contactEmail: 'researcher@example.test',
      apiKey: 'secret'
    })
  })

  it('rejects custom Connector lifecycle mutations from remote callers before a workflow can run', async () => {
    const { connectorMethod, dependencies } = createDependencies()
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    const attempts = [
      [
        settingsIntegrationApplicationCommands.addCustomServer,
        [{ name: 'custom', displayName: 'Custom', transport: 'stdio', command: 'custom-mcp' }]
      ],
      [
        settingsIntegrationApplicationCommands.setCustomServerEnabled,
        [{ id: 'server-1', enabled: true }]
      ],
      [settingsIntegrationApplicationCommands.removeCustomServer, [{ id: 'server-1' }]],
      [
        settingsIntegrationApplicationCommands.updateCustomServer,
        [{ id: 'server-1', transport: 'stdio', command: 'replacement-mcp' }]
      ]
    ] as const

    for (const [command, args] of attempts) {
      await expect(router.dispatcher.invoke(command, invocation(args))).rejects.toThrow(
        `Channel only available from the local app: ${command.name}`
      )
    }

    expect(connectorMethod('addCustomServer')).not.toHaveBeenCalled()
    expect(connectorMethod('setCustomServerEnabled')).not.toHaveBeenCalled()
    expect(connectorMethod('removeCustomServer')).not.toHaveBeenCalled()
    expect(connectorMethod('updateCustomServer')).not.toHaveBeenCalled()
  })

  it('allows custom Connector lifecycle, authentication, secrets, and retry only locally', async () => {
    const { connectorMethod, dependencies } = createDependencies()
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    const localCaller = createWebCallerContext('local-human')

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.addCustomServer,
      invocation(
        [{ name: 'custom', displayName: 'Custom', transport: 'stdio', command: 'custom-mcp' }],
        localCaller
      )
    )
    expect(connectorMethod('addCustomServer')).toHaveBeenCalledWith({
      name: 'custom',
      displayName: 'Custom',
      transport: 'stdio',
      command: 'custom-mcp'
    })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setCustomServerEnabled,
      invocation([{ id: 'server-1', enabled: false }], localCaller)
    )
    expect(connectorMethod('setCustomServerEnabled')).toHaveBeenCalledWith({
      id: 'server-1',
      enabled: false
    })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.removeCustomServer,
      invocation([{ id: 'server-1' }], localCaller)
    )
    expect(connectorMethod('removeCustomServer')).toHaveBeenCalledWith({ id: 'server-1' })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.updateCustomServer,
      invocation(
        [
          {
            id: 'server-2',
            description: 'Updated',
            transport: 'streamable_http',
            url: 'https://mcp.example.test'
          }
        ],
        localCaller
      )
    )
    expect(connectorMethod('updateCustomServer')).toHaveBeenCalledWith({
      id: 'server-2',
      description: 'Updated',
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.authenticateCustomServer,
      invocation([{ id: 'server-1' }] as const, localCaller)
    )
    expect(connectorMethod('authenticateCustomServer')).toHaveBeenCalledWith({ id: 'server-1' })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.cancelCustomServerAuthentication,
      invocation([{ id: 'server-1' }] as const, createWebCallerContext('local-human'))
    )
    expect(connectorMethod('cancelCustomServerAuthentication')).toHaveBeenCalledWith({
      id: 'server-1'
    })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.disconnectCustomServer,
      invocation([{ id: 'server-1' }] as const, createWebCallerContext('local-human'))
    )
    expect(connectorMethod('disconnectCustomServer')).toHaveBeenCalledWith({ id: 'server-1' })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.retryCustomServer,
      invocation([{ id: 'server-1' }] as const, createWebCallerContext('local-human'))
    )
    expect(connectorMethod('retryCustomServer')).toHaveBeenCalledWith({ id: 'server-1' })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.setOpenAlexCredential,
      invocation([{ apiKey: 'openalex-key' }] as const, createWebCallerContext('local-human'))
    )
    expect(connectorMethod('setOpenAlexCredential')).toHaveBeenCalledWith({
      apiKey: 'openalex-key'
    })

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.validateOpenAlexCredential,
      invocation([{ apiKey: 'openalex-key' }] as const, createWebCallerContext('local-human'))
    )
    expect(connectorMethod('validateOpenAlexCredential')).toHaveBeenCalledWith({
      apiKey: 'openalex-key'
    })

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.authenticateCustomServer,
        invocation(
          [{ id: 'server-1' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow(
      'Channel only available from the local app: settings:authenticate-custom-server'
    )

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.cancelCustomServerAuthentication,
        invocation(
          [{ id: 'server-1' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow(
      'Channel only available from the local app: settings:cancel-custom-server-authentication'
    )

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.disconnectCustomServer,
        invocation(
          [{ id: 'server-1' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow(
      'Channel only available from the local app: settings:disconnect-custom-server'
    )

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.retryCustomServer,
        invocation(
          [{ id: 'server-1' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow('Channel only available from the local app: settings:retry-custom-server')

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.setOpenAlexCredential,
        invocation(
          [{ apiKey: 'openalex-key' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow('Channel only available from the local app: settings:set-openalex-credential')

    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.validateOpenAlexCredential,
        invocation(
          [{ apiKey: 'openalex-key' }] as const,
          createWebCallerContext('remote-human', { location: 'remote' })
        )
      )
    ).rejects.toThrow(
      'Channel only available from the local app: settings:validate-openalex-credential'
    )
  })

  it('allows only current human callers to settle Connector and Skill-import approvals', async () => {
    const { dependencies } = createDependencies()
    const respondConnector = dependencies.connectorApprovals.respond as ReturnType<typeof vi.fn>
    const respondSkill = dependencies.skillImportApprovals.respond as ReturnType<typeof vi.fn>
    const getPendingConnector = dependencies.connectorApprovals.getPending as ReturnType<
      typeof vi.fn
    >
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, dependencies)

    const localHuman = createWebCallerContext('local-human')
    const remoteHuman = createWebCallerContext('remote-human', { location: 'remote' })
    const electronHuman = createElectronCallerContext(7)

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondConnectorApproval,
      invocation([{ id: 'connector-local', decision: 'once' }] as const, localHuman)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondSkillImportApproval,
      invocation([{ id: 'skill-remote', items: [] }] as const, remoteHuman)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondConnectorApproval,
      invocation([{ id: 'connector-electron', decision: 'deny' }] as const, electronHuman)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.replayConnectorApproval,
      invocation(['connector-pending'] as const, remoteHuman)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.replayPendingConnectorApprovals,
      invocation([] as const, remoteHuman)
    )

    expect(respondConnector.mock.calls).toEqual([
      ['connector-local', 'once'],
      ['connector-electron', 'deny']
    ])
    expect(respondSkill).toHaveBeenCalledWith({ id: 'skill-remote', items: [] })
    expect(getPendingConnector).toHaveBeenCalledWith('connector-pending')
    expect(dependencies.connectorApprovals.replayPending).toHaveBeenCalledOnce()

    const deniedCallers = [
      createCallerContext({
        clientId: 'agent-session',
        lifecycleClientId: 'web:agent-session',
        leaseId: 'agent-session',
        surface: 'web',
        location: 'local',
        principalKind: 'agent-session',
        actionOrigin: 'agent-session'
      }),
      createTaskCallerContext()
    ]

    for (const callerContext of deniedCallers) {
      await expect(
        router.dispatcher.invoke(
          settingsIntegrationApplicationCommands.respondConnectorApproval,
          invocation([{ id: 'blocked', decision: 'global' }] as const, callerContext)
        )
      ).rejects.toThrow('Only a current human caller can respond to connector approval requests.')
      await expect(
        router.dispatcher.invoke(
          settingsIntegrationApplicationCommands.replayConnectorApproval,
          invocation(['blocked'] as const, callerContext)
        )
      ).rejects.toThrow('Only a current human caller can reopen connector approval requests.')
      await expect(
        router.dispatcher.invoke(
          settingsIntegrationApplicationCommands.replayPendingConnectorApprovals,
          invocation([] as const, callerContext)
        )
      ).rejects.toThrow('Only a current human caller can reopen connector approval requests.')
      await expect(
        router.dispatcher.invoke(
          settingsIntegrationApplicationCommands.respondSkillImportApproval,
          invocation([{ id: 'blocked', cancelled: true }] as const, callerContext)
        )
      ).rejects.toThrow(
        'Only a current human caller can respond to Skill import approval requests.'
      )
    }

    const expiredHuman = createWebCallerContext('expired-human', {
      isAuthorizationCurrent: () => false
    })
    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.respondConnectorApproval,
        invocation([{ id: 'blocked', decision: 'global' }] as const, expiredHuman)
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    await expect(
      router.dispatcher.invoke(
        settingsIntegrationApplicationCommands.respondSkillImportApproval,
        invocation([{ id: 'blocked', cancelled: true }] as const, expiredHuman)
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(respondConnector).toHaveBeenCalledTimes(2)
    expect(respondSkill).toHaveBeenCalledTimes(1)
  })

  it('preserves owner-held late-ID, pending replay, and settled-event ordering', async () => {
    const { dependencies } = createDependencies()
    const connectorApprovalBroker = new ApprovalBroker({
      generateId: () => 'connector-1',
      broadcast: vi.fn(),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: vi.fn()
    })
    let sequence = 0
    const skillBroadcasts: string[] = []
    const settledIds: string[] = []
    const skillImportApprovalBroker = new SkillImportApprovalBroker({
      generateId: () => `skill-${++sequence}`,
      broadcast: (request) => skillBroadcasts.push(request.id),
      onSettled: (id) => settledIds.push(id),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: vi.fn()
    })
    const router = createApplicationCommandRouter()
    registerIntegrationSettingsApplicationCommands(router.registrar, {
      ...dependencies,
      connectorApprovals: connectorApprovalBroker,
      skillImportApprovals: skillImportApprovalBroker
    })
    const human = createWebCallerContext('approval-human', { location: 'remote' })
    const approvalInfo = (sessionId: string): SkillImportApprovalInfo => ({
      sessionId,
      source: { kind: 'attachment', label: `${sessionId}.skill` },
      previews: [],
      skipped: []
    })

    const connectorDecision = connectorApprovalBroker.request({
      connector: 'pubchem',
      method: 'search',
      argsPreview: '{}'
    })
    const firstSkillResponse = skillImportApprovalBroker.request(approvalInfo('session-1'))
    const secondSkillResponse = skillImportApprovalBroker.request(approvalInfo('session-2'))
    expect(skillBroadcasts).toEqual(['skill-1', 'skill-2'])
    skillBroadcasts.length = 0

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.replayPendingConnectorApprovals,
      invocation([] as const, human)
    )

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.replayPendingSkillImportApprovals,
      invocation([] as const, human)
    )
    expect(skillBroadcasts).toEqual(['skill-1', 'skill-2'])

    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondConnectorApproval,
      invocation([{ id: 'unknown', decision: 'global' }] as const, human)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondSkillImportApproval,
      invocation([{ id: 'unknown', cancelled: true }] as const, human)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondConnectorApproval,
      invocation([{ id: 'connector-1', decision: 'once' }] as const, human)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondSkillImportApproval,
      invocation([{ id: 'skill-1', items: [] }] as const, human)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondSkillImportApproval,
      invocation([{ id: 'skill-1', cancelled: true }] as const, human)
    )
    await router.dispatcher.invoke(
      settingsIntegrationApplicationCommands.respondSkillImportApproval,
      invocation([{ id: 'skill-2', cancelled: true }] as const, human)
    )

    await expect(connectorDecision).resolves.toBe('once')
    await expect(firstSkillResponse).resolves.toEqual({ id: 'skill-1', items: [] })
    await expect(secondSkillResponse).resolves.toEqual({ id: 'skill-2', cancelled: true })
    expect(settledIds).toEqual(['skill-1', 'skill-2'])
  })
})
