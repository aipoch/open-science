import type { ActiveSession } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import { codexFramework, opencodeFramework } from '../agent-framework'
import { AcpBackendGenerationOwner } from './backend-generation-owner'
import {
  SIDE_CHAT_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityPolicy
} from './session-capability-owner'
import { AcpSessionEnvironmentPolicy } from './session-environment-policy'
import { AcpSessionRegistry } from './session-registry'

const permissionProfile = (): SessionPermissionProfileState => ({
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
})

const publishSession = (
  registry: AcpSessionRegistry,
  appSessionId: string,
  projectId: string
): void => {
  const reservation = registry.reserve({ sessionIds: [appSessionId] })
  if (reservation.collision) throw reservation.collision
  registry.publish(reservation.reservation, appSessionId, {
    session: { sessionId: appSessionId } as unknown as ActiveSession,
    cwd: '/workspace',
    projectId,
    frameworkId: 'codex',
    permissionProfile: permissionProfile()
  })
  reservation.reservation.release()
}

type SessionEnvironmentFixture = Readonly<{
  backendGeneration: AcpBackendGenerationOwner
  refreshDynamicAvailability: ReturnType<typeof vi.fn>
  toolingAvailability: ReturnType<typeof vi.fn>
  applicationSystemPromptAppends: ReturnType<typeof vi.fn>
  registry: AcpSessionRegistry
  policy: AcpSessionEnvironmentPolicy
}>

const createPolicy = (
  defaultProjectId: string | undefined = 'default-project',
  capabilityPolicy?: SessionCapabilityPolicy
): SessionEnvironmentFixture => {
  const backendGeneration = new AcpBackendGenerationOwner(codexFramework)
  const refreshDynamicAvailability = vi.fn(async () => undefined)
  const toolingAvailability = vi.fn(() =>
    Object.freeze({
      artifacts: true,
      notebook: false,
      skillImport: true,
      plan: false,
      hostAgents: false,
      hostSkills: false
    })
  )
  const applicationSystemPromptAppends = vi.fn(() => Object.freeze(['Application guidance.']))
  const registry = new AcpSessionRegistry()
  const policy = new AcpSessionEnvironmentPolicy({
    backendGeneration,
    capabilities: { refreshDynamicAvailability, toolingAvailability },
    presentation: { applicationSystemPromptAppends },
    registry,
    ...(defaultProjectId ? { defaultProjectId } : {}),
    ...(capabilityPolicy ? { capabilityPolicy } : {}),
    planSystemPromptAppend: 'Plan guidance.'
  })

  return {
    backendGeneration,
    refreshDynamicAvailability,
    toolingAvailability,
    applicationSystemPromptAppends,
    registry,
    policy
  }
}

describe('ACP Session environment policy', () => {
  it('derives immutable prompt appends and current tooling without caching backend facts', () => {
    const fixture = createPolicy()

    expect(fixture.policy.systemPromptAppends('Skill guidance.')).toEqual([
      'Application guidance.',
      'Plan guidance.',
      'Skill guidance.'
    ])
    expect(Object.isFrozen(fixture.policy.systemPromptAppends())).toBe(true)
    expect(fixture.toolingAvailability).toHaveBeenLastCalledWith({
      framework: codexFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: { role: 'primary', delegation: 'denied' }
    })
    expect(fixture.applicationSystemPromptAppends).toHaveBeenCalledWith(
      expect.any(Object),
      'primary'
    )

    fixture.backendGeneration
      .prepare(
        { epoch: 1, assertCurrent: vi.fn() },
        {
          framework: opencodeFramework,
          executablePath: '/bin/opencode',
          env: {},
          systemPromptAppends: ['Backend guidance.']
        }
      )
      .publish()

    expect(fixture.policy.systemPromptAppends()).toEqual([
      'Application guidance.',
      'Plan guidance.',
      'Backend guidance.'
    ])
    expect(fixture.toolingAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({ framework: opencodeFramework })
    )
  })

  it('omits primary and Plan guidance for a restricted Session role', () => {
    const fixture = createPolicy('default-project', SIDE_CHAT_SESSION_CAPABILITY_POLICY)
    fixture.applicationSystemPromptAppends.mockReturnValueOnce(Object.freeze([]))

    expect(fixture.policy.role()).toBe('side-chat')
    expect(fixture.policy.systemPromptAppends()).toEqual([])
    expect(fixture.applicationSystemPromptAppends).toHaveBeenCalledWith(
      expect.any(Object),
      'side-chat'
    )
  })

  it('refreshes dynamic capability state before backend-native prompt projection', async () => {
    const fixture = createPolicy()

    await expect(fixture.policy.backendSystemPromptAppends()).resolves.toEqual([
      'Application guidance.',
      'Plan guidance.'
    ])
    expect(fixture.refreshDynamicAvailability).toHaveBeenCalledOnce()
    expect(fixture.applicationSystemPromptAppends).toHaveBeenCalledAfter(
      fixture.refreshDynamicAvailability
    )
  })

  it('resolves live Session projects before the configured and runtime fallbacks', () => {
    const fixture = createPolicy()

    expect(fixture.policy.projectId('missing')).toBe('default-project')
    publishSession(fixture.registry, 'session-1', 'session-project')
    expect(fixture.policy.projectId('session-1')).toBe('session-project')

    const runtimeFallback = createPolicy(undefined).policy
    expect(runtimeFallback.projectId('missing')).toBe(DEFAULT_UPLOAD_PROJECT_ID)
  })
})
