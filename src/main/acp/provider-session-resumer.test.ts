import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AcpCreateSessionResponse, AcpResumeSessionRequest } from '../../shared/acp'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { claudeCodeFramework } from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpProviderSessionResumer } from './provider-session-resumer'
import {
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  SIDE_CHAT_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityPolicy
} from './session-capability-owner'
import { AcpSessionRegistry } from './session-registry'

const permissionProfile: SessionPermissionProfileState = {
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
}

const backend: AcpBackendGenerationView = {
  framework: claudeCodeFramework,
  backendId: 'claude-code',
  session: { modelRequired: false },
  prompt: { systemPromptAppends: [] },
  context: { supportsImageInput: false },
  adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
}

type HarnessOptions = {
  attached?: boolean
  attachError?: Error
  backendAfterFirstConfigure?: AcpBackendGenerationView
  capabilityPolicy?: SessionCapabilityPolicy
  configureError?: Error
  ensureConnected?: () => Promise<ClientConnection>
  foreignIdentityCollision?: (sessionIds: readonly string[]) => Error | undefined
  invalidateDuringResume?: boolean
  observerError?: Error
  resumeError?: unknown
  supportsResume?: boolean
}

type ResumerHarness = {
  adopt: ReturnType<typeof vi.fn>
  assertCurrentConnection: ReturnType<typeof vi.fn>
  attachSession: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  clearLivePermissionProfile: ReturnType<typeof vi.fn>
  configure: ReturnType<typeof vi.fn>
  configurePermissionProfile: ReturnType<typeof vi.fn>
  connection: ClientConnection
  disconnectTimedOutConnection: ReturnType<typeof vi.fn>
  fireTimeout: () => void
  identityClaimedAtAdoption: () => boolean
  order: string[]
  providerSession: ActiveSession
  provision: ReturnType<typeof vi.fn>
  registry: AcpSessionRegistry
  release: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  resume: (request?: Partial<AcpResumeSessionRequest>) => Promise<AcpCreateSessionResponse>
  setTimer: ReturnType<typeof vi.fn>
  successorSession: ActiveSession
}

const createHarness = (options: HarnessOptions = {}): ResumerHarness => {
  const order: string[] = []
  let timerCallback: (() => void) | undefined
  let identityClaimedAtAdoption = false
  let currentBackend = backend
  const providerSession = {
    sessionId: 'provider-session',
    dispose: vi.fn(() => order.push('session dispose'))
  } as unknown as ActiveSession
  const successorSession = {
    sessionId: 'successor-provider-session',
    dispose: vi.fn()
  } as unknown as ActiveSession
  const registry = new AcpSessionRegistry({
    foreignIdentityCollision: options.foreignIdentityCollision
  })
  vi.spyOn(registry, 'reserve').mockImplementation((input) => {
    order.push(input.reservation ? 'extend identity' : 'reserve identity')
    return AcpSessionRegistry.prototype.reserve.call(registry, input)
  })
  vi.spyOn(registry, 'publish').mockImplementation((...args) => {
    order.push('registry publish')
    return AcpSessionRegistry.prototype.publish.call(registry, ...args)
  })
  const request = vi.fn(async () => {
    order.push('session/resume')
    if (options.invalidateDuringResume) {
      registry.invalidatePending()
      const successor = registry.reserve({
        sessionIds: ['stable-app-session', successorSession.sessionId],
        blockStartup: false
      })
      if (successor.collision) throw successor.collision
      registry.publish(successor.reservation, 'stable-app-session', {
        session: successorSession,
        cwd: '/successor-workspace',
        projectName: 'successor-project',
        frameworkId: 'claude-code',
        backendId: 'claude-code',
        permissionProfile
      })
      successor.reservation.release()
    }
    if (options.resumeError !== undefined) throw options.resumeError
    return { sessionId: providerSession.sessionId }
  })
  const attachSession = vi.fn(() => {
    order.push('sdk attach')
    if (options.attachError) throw options.attachError
    return providerSession
  })
  const connection = { agent: { request, attachSession } } as unknown as ClientConnection
  const commit = vi.fn(() => order.push('capability commit'))
  const release = vi.fn(() => order.push('capability release'))
  const adopt = vi.fn(
    async (
      stableAppSessionId: string,
      adoption: { identity: { release: () => void }; cwd: string }
    ) => {
      order.push('adopt fresh')
      identityClaimedAtAdoption = registry.isIdentityClaimed(stableAppSessionId)
      adoption.identity.release()
      return {
        sessionId: stableAppSessionId,
        cwd: adoption.cwd,
        frameworkId: 'claude-code' as const,
        backendId: 'claude-code',
        contextReset: true as const
      }
    }
  )
  const disconnectTimedOutConnection = vi.fn(async () => {
    order.push('disconnect')
    registry.invalidatePending()
  })
  const configure = vi.fn(async (input: { backend: AcpBackendGenerationView }) => {
    order.push('configure')
    if (options.configureError) throw options.configureError
    if (configure.mock.calls.length === 1 && options.backendAfterFirstConfigure) {
      currentBackend = options.backendAfterFirstConfigure
    }
    return {
      permissionProfile,
      appliedModel: input.backend.session.effort,
      configOptions: undefined
    }
  })
  const configurePermissionProfile = vi.fn(async () => {
    order.push('configure permission')
    return permissionProfile
  })
  if (options.attached) {
    const attached = registry.reserve({
      sessionIds: ['stable-app-session', providerSession.sessionId],
      blockStartup: false
    })
    if (attached.collision) throw attached.collision
    registry.publish(attached.reservation, 'stable-app-session', {
      session: providerSession,
      cwd: '/old-workspace',
      projectName: 'old-project',
      frameworkId: 'claude-code',
      backendId: 'claude-code',
      permissionProfile
    })
    attached.reservation.release()
    order.length = 0
  }
  const setTimer = vi.fn((callback: () => void) => {
    timerCallback = callback
    return {} as ReturnType<typeof setTimeout>
  })
  const assertCurrentConnection = vi.fn()
  const clearLivePermissionProfile = vi.fn()
  const provision = vi.fn(async () => {
    order.push('capability provision')
    return {
      mcpServers: [],
      descriptor: {
        role: 'primary' as const,
        delegation: 'denied' as const,
        transport: 'none' as const,
        capabilities: [],
        canonicalMcpServerNames: [],
        modelFacingMcpServerNames: [],
        controlRpcMethods: []
      },
      commit,
      release
    }
  })
  const resumer = new AcpProviderSessionResumer({
    defaultCwd: '/default',
    defaultProjectName: 'default-project',
    currentCwd: () => undefined,
    currentConnection: () => connection,
    ensureConnected:
      options.ensureConnected ??
      vi.fn(async () => {
        order.push('connect')
        return connection
      }),
    assertCurrentConnection,
    disconnectTimedOutConnection,
    resumeCapabilityAdvertised: () => options.supportsResume !== false,
    currentBackend: () => currentBackend,
    registry,
    reserveIdentity: (sessionId) =>
      registry.reserve({
        sessionIds: [sessionId],
        mayRenewAfterConnectionSetup: true,
        blockStartup: false
      }),
    capabilities: { provision },
    capabilityPolicy: options.capabilityPolicy ?? CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    configurator: { configure, configurePermissionProfile },
    adopter: { adopt },
    clearLivePermissionProfile,
    updateCwd: () => order.push('cwd callback'),
    pushEvent: () => {
      order.push('event callback')
      if (options.observerError) throw options.observerError
    },
    emitState: () => {
      order.push('state callback')
      if (options.observerError) throw options.observerError
    },
    resumeTimeoutMs: 30_000,
    setTimer,
    clearTimer: () => undefined,
    diagnosticContext: () => ({})
  })
  const resume = (
    request: Partial<AcpResumeSessionRequest> = {}
  ): Promise<AcpCreateSessionResponse> =>
    resumer.resume({
      sessionId: 'stable-app-session',
      cwd: '/workspace',
      projectName: 'project-a',
      ...request
    })

  return {
    adopt,
    assertCurrentConnection,
    attachSession,
    commit,
    clearLivePermissionProfile,
    configure,
    configurePermissionProfile,
    connection,
    disconnectTimedOutConnection,
    fireTimeout: () => timerCallback?.(),
    identityClaimedAtAdoption: () => identityClaimedAtAdoption,
    order,
    providerSession,
    provision,
    registry,
    release,
    request,
    resume,
    setTimer,
    successorSession
  }
}

describe('AcpProviderSessionResumer', () => {
  it('preserves the runtime capability policy on compatible provider resume', async () => {
    const harness = createHarness({ capabilityPolicy: SIDE_CHAT_SESSION_CAPABILITY_POLICY })

    await harness.resume()

    expect(harness.provision).toHaveBeenCalledWith(
      expect.objectContaining({ policy: SIDE_CHAT_SESSION_CAPABILITY_POLICY })
    )
  })

  it('refreshes an attached Session without entering provider startup', async () => {
    const harness = createHarness({ attached: true })

    const response = await harness.resume({
      cwd: '/moved-workspace',
      projectName: 'moved-project',
      specialistId: 'specialist-1',
      permissionProfile: 'full'
    })

    expect(response).toEqual({
      sessionId: 'stable-app-session',
      providerSessionId: 'provider-session',
      cwd: resolve('/moved-workspace'),
      frameworkId: 'claude-code',
      backendId: 'claude-code'
    })
    expect(harness.configurePermissionProfile).toHaveBeenCalledWith({
      backend,
      connection: harness.connection,
      session: harness.providerSession,
      permissionProfile: 'full'
    })
    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot()).toMatchObject({
      cwd: resolve('/moved-workspace'),
      projectName: 'moved-project',
      specialistId: 'specialist-1',
      permissionProfile
    })
    expect(harness.registry.currentSessionId).toBe('stable-app-session')
    expect(harness.clearLivePermissionProfile).toHaveBeenCalledWith('stable-app-session')
    expect(harness.order).toEqual(['configure permission', 'cwd callback', 'state callback'])
    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.adopt).not.toHaveBeenCalled()
    expect(harness.setTimer).not.toHaveBeenCalled()
    expect(harness.assertCurrentConnection).toHaveBeenCalledWith(harness.connection)
  })

  it('does not update a successor attachment after permission configuration', async () => {
    const harness = createHarness({ attached: true })
    let markConfigureStarted!: () => void
    let finishConfigure!: () => void
    const configureStarted = new Promise<void>((resolve) => {
      markConfigureStarted = resolve
    })
    const configureGate = new Promise<void>((resolve) => {
      finishConfigure = resolve
    })
    harness.configurePermissionProfile.mockImplementationOnce(async () => {
      markConfigureStarted()
      await configureGate
      return { ...permissionProfile, selectedProfile: 'full' as const }
    })

    const resumed = harness.resume({
      cwd: '/stale-workspace',
      projectName: 'stale-project',
      specialistId: 'stale-specialist'
    })
    await configureStarted
    const oldAttachment = harness.registry.lookup('stable-app-session')?.attachment
    if (!oldAttachment) throw new Error('expected attached Session')
    harness.registry.detach(oldAttachment, 'connection')
    const successor = harness.registry.reserve({
      sessionIds: ['stable-app-session', harness.successorSession.sessionId],
      blockStartup: false
    })
    if (successor.collision) throw successor.collision
    harness.registry.publish(successor.reservation, 'stable-app-session', {
      session: harness.successorSession,
      cwd: '/successor-workspace',
      projectName: 'successor-project',
      frameworkId: 'claude-code',
      backendId: 'claude-code',
      permissionProfile
    })
    successor.reservation.release()
    harness.order.length = 0
    finishConfigure()

    await expect(resumed).rejects.toThrow('ACP session startup was superseded.')
    expect(harness.configurePermissionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ permissionProfile: 'ask' })
    )
    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot()).toMatchObject({
      cwd: '/successor-workspace',
      projectName: 'successor-project',
      specialistId: 'stale-specialist',
      permissionProfile
    })
    expect(harness.registry.currentSessionId).toBe('stable-app-session')
    expect(harness.assertCurrentConnection).not.toHaveBeenCalled()
    expect(harness.order).toEqual([])
  })

  it('does not commit attached metadata when the connection is superseded', async () => {
    const harness = createHarness({ attached: true })
    const select = vi.spyOn(harness.registry, 'select')
    harness.configurePermissionProfile.mockResolvedValueOnce({
      ...permissionProfile,
      selectedProfile: 'full',
      effectiveProfile: 'full'
    })
    harness.assertCurrentConnection.mockImplementationOnce(() => {
      throw new Error('ACP session startup was superseded.')
    })

    await expect(
      harness.resume({ cwd: '/stale-workspace', projectName: 'stale-project' })
    ).rejects.toThrow('ACP session startup was superseded.')

    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot()).toMatchObject({
      cwd: '/old-workspace',
      projectName: 'old-project',
      permissionProfile
    })
    expect(select).not.toHaveBeenCalled()
    expect(harness.order).not.toContain('cwd callback')
    expect(harness.order).not.toContain('state callback')
  })

  it('resumes and publishes a provider Session under its stable application id', async () => {
    const harness = createHarness()

    const response = await harness.resume()

    expect(response).toEqual({
      sessionId: 'stable-app-session',
      providerSessionId: 'provider-session',
      cwd: resolve('/workspace'),
      frameworkId: 'claude-code',
      backendId: 'claude-code'
    })
    expect(harness.registry.lookup('stable-app-session')?.attachment?.session).toBe(
      harness.providerSession
    )
    expect(harness.registry.resolveAppSessionId('provider-session')).toBe('stable-app-session')
    expect(harness.order).toEqual([
      'reserve identity',
      'connect',
      'extend identity',
      'capability provision',
      'session/resume',
      'sdk attach',
      'extend identity',
      'configure',
      'registry publish',
      'capability commit',
      'cwd callback',
      'event callback',
      'state callback'
    ])
  })

  it('times out a stalled reconnect and tears down its half-open connection', async () => {
    const harness = createHarness({
      ensureConnected: () => new Promise<ClientConnection>(() => undefined)
    })

    const resumed = harness.resume()
    harness.fireTimeout()

    await expect(resumed).rejects.toThrow('ACP session resume timed out.')
    expect(harness.disconnectTimedOutConnection).toHaveBeenCalledOnce()
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('transfers its reservation to fresh adoption when Resume Policy rejects the backend', async () => {
    const harness = createHarness()

    await expect(harness.resume({ previousFrameworkId: 'opencode' })).resolves.toMatchObject({
      sessionId: 'stable-app-session',
      contextReset: true
    })

    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.adopt).toHaveBeenCalledOnce()
    expect(harness.identityClaimedAtAdoption()).toBe(true)
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('releases only the failed Resume provision before adopting an unresumable session', async () => {
    const harness = createHarness({ resumeError: { code: -32002, message: 'Resource not found' } })

    await expect(harness.resume()).resolves.toMatchObject({ contextReset: true })

    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.order.indexOf('capability release')).toBeLessThan(
      harness.order.indexOf('adopt fresh')
    )
    expect(harness.adopt).toHaveBeenCalledOnce()
  })

  it('releases the provision when the SDK cannot attach the resumed Session', async () => {
    const failure = new Error('SDK attach failed')
    const harness = createHarness({ attachError: failure })

    await expect(harness.resume()).rejects.toBe(failure)

    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
    expect(harness.adopt).not.toHaveBeenCalled()
  })

  it('disposes the attached provider Session when its provider id collides', async () => {
    const collision = new Error('provider identity collision')
    const harness = createHarness({
      foreignIdentityCollision: (sessionIds) =>
        sessionIds.includes('provider-session') ? collision : undefined
    })

    await expect(harness.resume()).rejects.toBe(collision)

    expect(harness.providerSession.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
  })

  it('does not clean or overwrite a same-id successor after the Resume attempt is superseded', async () => {
    const harness = createHarness({
      invalidateDuringResume: true,
      resumeError: { code: -32002, message: 'Resource not found' }
    })

    await expect(harness.resume()).rejects.toThrow('ACP session startup was superseded.')

    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: false })
    expect(harness.adopt).not.toHaveBeenCalled()
    expect(harness.registry.lookup('stable-app-session')?.attachment?.session).toBe(
      harness.successorSession
    )
    expect(harness.successorSession.dispose).not.toHaveBeenCalled()
  })

  it('disposes the attached-but-unpublished Session when configuration fails', async () => {
    const failure = new Error('configuration failed')
    const harness = createHarness({ configureError: failure })

    await expect(harness.resume()).rejects.toBe(failure)

    expect(harness.providerSession.dispose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledWith({ ownsStableIdentity: true })
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.registry.lookup('stable-app-session')).toBeUndefined()
  })

  it('publishes ownership before fallible observers without rolling back their Session', async () => {
    const harness = createHarness({ observerError: new Error('observer failed') })

    await expect(harness.resume()).resolves.toMatchObject({ sessionId: 'stable-app-session' })

    expect(harness.registry.lookup('stable-app-session')?.attachment?.session).toBe(
      harness.providerSession
    )
    expect(harness.order.indexOf('registry publish')).toBeLessThan(
      harness.order.indexOf('capability commit')
    )
    expect(harness.order.indexOf('capability commit')).toBeLessThan(
      harness.order.indexOf('event callback')
    )
    expect(harness.order).toContain('state callback')
  })

  it('targets the persisted provider Session id instead of the stable application alias', async () => {
    const harness = createHarness()

    const response = await harness.resume({ providerSessionId: 'provider-session' })

    expect(harness.request.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'provider-session'
    })
    expect(response).toMatchObject({
      sessionId: 'stable-app-session',
      providerSessionId: 'provider-session'
    })
  })

  it('fresh-adopts when resume capability is not advertised', async () => {
    const harness = createHarness({ supportsResume: false })

    await expect(harness.resume()).resolves.toMatchObject({
      sessionId: 'stable-app-session',
      contextReset: true
    })

    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.adopt).toHaveBeenCalledOnce()
    expect(harness.order).not.toContain('capability provision')
    expect(harness.registry.isIdentityClaimed('stable-app-session')).toBe(false)
  })

  it('replays configuration against a live effort change before publication', async () => {
    const nextBackend: AcpBackendGenerationView = {
      ...backend,
      session: { ...backend.session, effort: 'high' }
    }
    const harness = createHarness({ backendAfterFirstConfigure: nextBackend })

    await harness.resume()

    expect(harness.configure).toHaveBeenCalledTimes(2)
    expect(harness.registry.lookup('stable-app-session')?.aggregate.snapshot().appliedModel).toBe(
      'high'
    )
  })
})
