import type { ActiveSession } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import {
  AcpSessionRegistry,
  type AcpPrimarySessionIdentityReservation,
  type AcpSessionRegistryEntry
} from './session-registry'

const providerSession = (sessionId: string): ActiveSession =>
  ({ sessionId }) as unknown as ActiveSession

const permissionProfile = (): SessionPermissionProfileState => ({
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
})

const reserve = (
  registry: AcpSessionRegistry,
  sessionIds: string[],
  publishedAppSessionId?: string
): AcpPrimarySessionIdentityReservation => {
  const result = registry.reserve({ sessionIds, publishedAppSessionId })
  if (result.collision) throw result.collision
  return result.reservation
}

const publish = (
  registry: AcpSessionRegistry,
  appSessionId: string,
  providerSessionId: string,
  publishedAppSessionId?: string
): AcpSessionRegistryEntry => {
  const reservation = reserve(
    registry,
    [...new Set([appSessionId, providerSessionId])],
    publishedAppSessionId
  )
  const publication = registry.publish(reservation, appSessionId, {
    session: providerSession(providerSessionId),
    cwd: '/workspace',
    projectName: 'project-1',
    frameworkId: 'claude-code',
    permissionProfile: permissionProfile()
  })
  reservation.release()
  return publication
}

describe('ACP session registry', () => {
  it('publishes stable identities, current selection, and active ordering atomically', () => {
    const registry = new AcpSessionRegistry()
    const firstA = publish(registry, 'app-a', 'provider-a')
    publish(registry, 'app-b', 'provider-b')

    expect(registry.currentSessionId).toBe('app-b')
    expect(registry.resolveAppSessionId('provider-a')).toBe('app-a')
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-a',
      'app-b'
    ])

    const replacement = publish(registry, 'app-a', 'provider-a-2', 'app-a')
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
    expect(registry.entries().map(({ appSessionId }) => appSessionId)).toEqual(['app-a', 'app-b'])
    expect(registry.currentSessionId).toBe('app-a')

    publish(registry, 'app-a', 'provider-a-3')
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-b',
      'app-a'
    ])
    expect(registry.currentSessionId).toBe('app-a')
  })

  it('reserves primary identities through an opaque blocker-owning handle', () => {
    const blockers = new Set<symbol>()
    const foreignCollision = new Error(
      'Primary session id collision with pending reviewer: reviewer-pending'
    )
    const foreignIdentityCollision = vi.fn((sessionIds: readonly string[]) =>
      sessionIds.includes('reviewer-pending') ? foreignCollision : undefined
    )
    const registry = new AcpSessionRegistry({
      addStartupBlocker: (token) => blockers.add(token),
      removeStartupBlocker: (token) => blockers.delete(token),
      foreignIdentityCollision
    })

    const reservation = reserve(registry, ['app-a'])
    expect(blockers).toHaveLength(1)
    expect(registry.isIdentityClaimed('app-a')).toBe(true)
    expect(() => reservation.assertCurrent()).not.toThrow()

    expect(registry.reserve({ sessionIds: ['app-a'] }).collision?.message).toBe(
      'Primary session id collision: app-a'
    )
    expect(registry.reserve({ sessionIds: ['reviewer-pending'] }).collision).toBe(foreignCollision)
    expect(foreignIdentityCollision).toHaveBeenCalledWith(['reviewer-pending'])

    const extended = registry.reserve({ reservation, sessionIds: ['provider-a'] })
    expect(extended.reservation).toBe(reservation)
    expect(registry.isIdentityClaimed('provider-a')).toBe(true)
    expect(registry.reserve({ sessionIds: ['provider-a'] }).collision?.message).toBe(
      'Primary session id collision: provider-a'
    )

    reservation.release()
    reservation.release()
    expect(blockers).toHaveLength(0)
    expect(registry.isIdentityClaimed('app-a')).toBe(false)
    expect(registry.isIdentityClaimed('provider-a')).toBe(false)
    expect(registry.reserve({ sessionIds: ['app-a'] }).collision).toBeUndefined()
  })

  it('delegates global reviewer priority ahead of primary collisions', () => {
    const pendingReviewer = new Error(
      'Primary session id collision with pending reviewer: reviewer-pending'
    )
    const activeReviewer = new Error('Primary session id collision with reviewer: reviewer-active')
    const foreignIdentityCollision = vi.fn((sessionIds: readonly string[]) => {
      if (sessionIds.includes('reviewer-pending')) return pendingReviewer
      if (sessionIds.includes('reviewer-active')) return activeReviewer
      return undefined
    })
    const registry = new AcpSessionRegistry({ foreignIdentityCollision })
    const primary = reserve(registry, ['primary-session'])

    const collision = registry.reserve({
      sessionIds: ['primary-session', 'reviewer-active', 'reviewer-pending']
    }).collision

    expect(collision).toBe(pendingReviewer)
    expect(foreignIdentityCollision).toHaveBeenLastCalledWith([
      'primary-session',
      'reviewer-active',
      'reviewer-pending'
    ])
    primary.release()
  })

  it('allows one connection-authorized reservation renewal across startup invalidation', () => {
    const blockers = new Set<symbol>()
    const registry = new AcpSessionRegistry({
      addStartupBlocker: (token) => blockers.add(token),
      removeStartupBlocker: (token) => blockers.delete(token)
    })
    const result = registry.reserve({
      sessionIds: ['app-a'],
      mayRenewAfterConnectionSetup: true,
      blockStartup: false
    })
    if (result.collision) throw result.collision

    expect(blockers).toHaveLength(0)
    registry.invalidatePending()
    expect(() => result.reservation.assertCurrent()).toThrow('ACP session startup was superseded.')

    expect(result.reservation.renew()).toBe(true)
    expect(blockers).toHaveLength(1)
    expect(() => result.reservation.assertCurrent()).not.toThrow()

    registry.invalidatePending()
    expect(() => result.reservation.renew()).toThrow('ACP session startup was superseded.')
    result.reservation.release()
    expect(blockers).toHaveLength(0)

    const sameGeneration = reserve(registry, ['same-generation'])
    expect(sameGeneration.renew()).toBe(false)
    sameGeneration.release()
  })

  it('serializes deletion against reservations and removes only the captured generation', () => {
    let blockForeign = false
    const foreignIdentityCollision = vi.fn((sessionIds: readonly string[]) =>
      blockForeign && sessionIds.includes('app-c') ? new Error('foreign collision') : undefined
    )
    const registry = new AcpSessionRegistry({ foreignIdentityCollision })
    publish(registry, 'app-a', 'provider-a')
    publish(registry, 'app-b', 'provider-b')

    const staleStartup = reserve(registry, ['app-c'])
    blockForeign = true
    foreignIdentityCollision.mockClear()
    const emptyDeletion = registry.beginDelete('app-c')
    expect(registry.reserve({ sessionIds: ['app-c'] }).collision?.message).toBe(
      'Primary session id collision with deletion in progress: app-c'
    )
    expect(foreignIdentityCollision).not.toHaveBeenCalled()
    expect(() => staleStartup.assertCurrent()).toThrow('ACP session startup was superseded.')
    expect(emptyDeletion.finish()).toMatchObject({ removed: false, wasActive: false })
    staleStartup.release()

    const activeTarget = registry.lookup('app-b')!
    const activeDeletion = registry.beginDelete('app-b')
    expect(registry.detach(activeTarget.attachment!, 'provider')).toBe(true)
    expect(activeDeletion.finish(activeTarget)).toMatchObject({
      removed: true,
      wasActive: true,
      currentSessionId: 'app-a'
    })
    expect(registry.lookup('app-b')).toBeUndefined()
    expect(registry.resolveAppSessionId('provider-b')).toBe('provider-b')

    const detached = registry.lookup('app-a')!
    expect(registry.detach(detached.attachment!, 'provider')).toBe(true)
    const detachedDeletion = registry.beginDelete('app-a')
    expect(detachedDeletion.finish(registry.lookup('app-a'))).toMatchObject({
      removed: true,
      wasActive: false,
      currentSessionId: 'app-a'
    })

    const oldEntry = publish(registry, 'app-d', 'provider-d')
    expect(registry.detach(oldEntry.attachment!, 'provider')).toBe(true)
    publish(registry, 'app-d', 'provider-d-2')
    const staleDeletion = registry.beginDelete('app-d')
    expect(staleDeletion.finish(oldEntry)).toMatchObject({ removed: false })
    expect(registry.lookup('app-d')?.attachment?.providerSessionId).toBe('provider-d-2')
  })

  it('selects an already-published app session without changing publication order', () => {
    const registry = new AcpSessionRegistry()
    publish(registry, 'app-a', 'provider-a')
    publish(registry, 'app-b', 'provider-b')

    registry.select('app-a')

    expect(registry.currentSessionId).toBe('app-a')
    expect(registry.entries(true).map(({ appSessionId }) => appSessionId)).toEqual([
      'app-a',
      'app-b'
    ])
  })

  it('retains detached affinity without claiming a primary identity', () => {
    const registry = new AcpSessionRegistry()

    registry.ensureAffinity('app-a').aggregate.setSpecialistId('specialist-1')

    expect(registry.lookup('app-a')?.aggregate.snapshot().specialistId).toBe('specialist-1')
    expect(registry.entries(true)).toEqual([])
    expect(registry.isIdentityClaimed('app-a')).toBe(false)
  })

  it('clears applied models without detaching active sessions', () => {
    const registry = new AcpSessionRegistry()
    const entry = publish(registry, 'app-a', 'provider-a')
    entry.aggregate.attach({
      session: entry.attachment!.session,
      cwd: '/workspace',
      projectName: 'project-1',
      frameworkId: 'claude-code',
      permissionProfile: permissionProfile(),
      appliedModel: 'model-1'
    })

    registry.clearAppliedModels()

    expect(registry.lookup('app-a')?.aggregate.snapshot().appliedModel).toBeUndefined()
    expect(registry.lookup('app-a')?.attachment?.session).toBe(entry.attachment?.session)
  })

  it('detaches connection state while retaining detached affinity', () => {
    const registry = new AcpSessionRegistry()
    const entry = publish(registry, 'app-a', 'provider-a')
    entry.aggregate.attach({
      session: entry.attachment!.session,
      cwd: '/workspace',
      projectName: 'project-1',
      frameworkId: 'codex',
      backendId: 'backend-1',
      permissionProfile: permissionProfile(),
      appliedModel: 'model-1'
    })
    entry.aggregate.setSpecialistId('specialist-1')
    entry.aggregate.setSpecialistPrefix('Use the selected specialist.')

    expect(registry.detach(entry.attachment!, 'connection')).toBe(true)

    expect(registry.currentSessionId).toBeUndefined()
    expect(registry.entries(true)).toEqual([])
    expect(registry.lookup('app-a')?.aggregate.snapshot()).toMatchObject({
      providerSessionId: undefined,
      cwd: undefined,
      projectName: undefined,
      frameworkId: 'codex',
      backendId: 'backend-1',
      permissionProfile: permissionProfile(),
      specialistId: 'specialist-1',
      specialistPrefix: 'Use the selected specialist.',
      appliedModel: undefined
    })
  })
})
