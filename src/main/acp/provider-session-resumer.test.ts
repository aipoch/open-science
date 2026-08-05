import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AcpCreateSessionResponse, AcpResumeSessionRequest } from '../../shared/acp'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { claudeCodeFramework } from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpProviderSessionResumer } from './provider-session-resumer'
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
  attachError?: Error
  backendAfterFirstConfigure?: AcpBackendGenerationView
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
  attachSession: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  configure: ReturnType<typeof vi.fn>
  connection: ClientConnection
  disconnectTimedOutConnection: ReturnType<typeof vi.fn>
  fireTimeout: () => void
  identityClaimedAtAdoption: () => boolean
  order: string[]
  providerSession: ActiveSession
  registry: AcpSessionRegistry
  release: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  resume: (request?: Partial<AcpResumeSessionRequest>) => Promise<AcpCreateSessionResponse>
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
  const resumer = new AcpProviderSessionResumer({
    defaultCwd: '/default',
    defaultProjectName: 'default-project',
    currentCwd: () => undefined,
    ensureConnected:
      options.ensureConnected ??
      vi.fn(async () => {
        order.push('connect')
        return connection
      }),
    assertCurrentConnection: vi.fn(),
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
    capabilities: {
      provision: vi.fn(async () => {
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
    },
    configurator: { configure },
    adopter: { adopt },
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
    setTimer: (callback) => {
      timerCallback = callback
      return {} as ReturnType<typeof setTimeout>
    },
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
    attachSession,
    commit,
    configure,
    connection,
    disconnectTimedOutConnection,
    fireTimeout: () => timerCallback?.(),
    identityClaimedAtAdoption: () => identityClaimedAtAdoption,
    order,
    providerSession,
    registry,
    release,
    request,
    resume,
    successorSession
  }
}

describe('AcpProviderSessionResumer', () => {
  it('resumes and publishes a provider Session under its stable application id', async () => {
    const harness = createHarness()

    const response = await harness.resume()

    expect(response).toEqual({
      sessionId: 'stable-app-session',
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

  it('preserves the advertised-resume failure without allocating capabilities', async () => {
    const harness = createHarness({ supportsResume: false })

    await expect(harness.resume()).rejects.toThrow('ACP agent does not support session resume.')

    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.adopt).not.toHaveBeenCalled()
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
