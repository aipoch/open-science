import type { ActiveSession } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import { AcpSessionRegistry, type AcpSessionRegistryEntry } from './session-registry'

const providerSession = (sessionId: string): ActiveSession =>
  ({ sessionId }) as unknown as ActiveSession

const permissionProfile = (): SessionPermissionProfileState => ({
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
})

const publish = (
  registry: AcpSessionRegistry,
  appSessionId: string,
  providerSessionId: string
): AcpSessionRegistryEntry =>
  registry.publish(appSessionId, {
    session: providerSession(providerSessionId),
    cwd: '/workspace',
    projectName: 'project-1',
    frameworkId: 'claude-code',
    permissionProfile: permissionProfile(),
    appliedModel: 'model-a'
  })

describe('ACP session registry', () => {
  it('owns stable identity, aliases, selection, and publication order', () => {
    const registry = new AcpSessionRegistry()
    const firstA = publish(registry, 'app-a', 'provider-a')
    publish(registry, 'app-b', 'provider-b')

    expect(registry.currentSessionId).toBe('app-b')
    expect(registry.resolveAppSessionId('provider-a')).toBe('app-a')
    expect(registry.hasProviderAlias('provider-a')).toBe(true)
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-a',
      'app-b'
    ])

    const replacement = publish(registry, 'app-a', 'provider-a-2')
    expect(registry.detach(firstA.attachment!, 'provider')).toBe(false)
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-a',
      'app-b'
    ])
    expect(registry.resolveAppSessionId('provider-a')).toBe('provider-a')
    expect(registry.resolveAppSessionId('provider-a-2')).toBe('app-a')

    expect(registry.detach(replacement.attachment!, 'provider')).toBe(true)
    expect(registry.lookup('app-a')?.aggregate.snapshot()).toMatchObject({
      providerSessionId: undefined,
      frameworkId: 'claude-code'
    })
    expect(registry.currentSessionId).toBe('app-a')

    publish(registry, 'app-a', 'provider-a-3')
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-b',
      'app-a'
    ])
  })

  it('keeps pure affinity without claiming a provider identity and clears applied models', () => {
    const registry = new AcpSessionRegistry()
    const affinity = registry.ensureAffinity('app-a')

    affinity.aggregate.setSpecialistId('specialist-a')
    expect(registry.hasProviderAlias('app-a')).toBe(false)
    expect(registry.entries(true)).toEqual([])

    publish(registry, 'app-a', 'provider-a')
    registry.clearAppliedModels()
    expect(registry.lookup('app-a')?.aggregate.snapshot()).toMatchObject({
      specialistId: 'specialist-a',
      appliedModel: undefined
    })
  })

  it('detaches connection state and removes only the captured generation', () => {
    const registry = new AcpSessionRegistry()
    const stale = publish(registry, 'app-a', 'provider-a')
    const replacement = publish(registry, 'app-a', 'provider-a-2')

    expect(registry.remove(stale).removed).toBe(false)
    expect(registry.detach(replacement.attachment!, 'connection')).toBe(true)
    expect(registry.currentSessionId).toBeUndefined()
    expect(registry.lookup('app-a')?.aggregate.snapshot()).toMatchObject({
      cwd: undefined,
      projectName: undefined,
      providerSessionId: undefined
    })

    const republished = publish(registry, 'app-a', 'provider-a-3')
    publish(registry, 'app-b', 'provider-b')
    registry.select('app-a')
    expect(registry.remove(republished)).toMatchObject({
      removed: true,
      wasActive: true,
      currentSessionId: 'app-b'
    })
    expect(registry.lookup('app-a')).toBeUndefined()
    expect(registry.resolveAppSessionId('provider-a-3')).toBe('provider-a-3')

    const detached = publish(registry, 'app-c', 'provider-c')
    registry.detach(detached.attachment!, 'provider')
    const detachedTarget = registry.lookup('app-c')!
    expect(registry.remove(detachedTarget)).toMatchObject({ removed: true, wasActive: false })
    expect(registry.lookup('app-c')).toBeUndefined()

    const capturedActive = publish(registry, 'app-d', 'provider-d')
    registry.select('app-d')
    expect(registry.detach(capturedActive.attachment!, 'provider')).toBe(true)
    expect(registry.remove(capturedActive)).toMatchObject({
      removed: true,
      wasActive: true,
      currentSessionId: 'app-b'
    })
  })
})
