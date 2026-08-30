import { describe, expect, it, vi } from 'vitest'

import {
  ClientLeaseRegistry,
  callerContextForEvent,
  canAccessSessionPlan,
  canSatisfyHumanApproval,
  createCallerContext,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  hasCallerAuthority
} from './caller-context'

describe('caller context', () => {
  it('preserves current lifecycle client ids across Electron, Web, and Task surfaces', () => {
    expect(createElectronCallerContext(7)).toMatchObject({
      clientId: '7',
      lifecycleClientId: 'electron:7',
      leaseId: 'electron:7',
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })
    expect(createWebCallerContext('browser-1')).toMatchObject({
      clientId: 'browser-1',
      lifecycleClientId: 'web:browser-1',
      leaseId: 'browser-1',
      surface: 'web',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })
    expect(createTaskCallerContext()).toMatchObject({
      clientId: 'headless-task-api',
      lifecycleClientId: 'web:headless-task-api',
      leaseId: 'headless-task-api',
      surface: 'task',
      location: 'local',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })
    expect(
      createTaskCallerContext({
        clientId: 'trusted-browser:browser-tab',
        location: 'remote'
      })
    ).toMatchObject({
      clientId: 'trusted-browser:browser-tab',
      lifecycleClientId: 'web:trusted-browser:browser-tab',
      leaseId: 'trusted-browser:browser-tab',
      surface: 'task',
      location: 'remote'
    })
  })

  it('keeps remote authority narrow and tied to authorization freshness', () => {
    let current = true
    const context = createWebCallerContext('browser-1', {
      location: 'remote',
      authorities: ['manage-remote-pairing'],
      isAuthorizationCurrent: () => current
    })

    expect(hasCallerAuthority(context, 'manage-remote-pairing')).toBe(true)
    current = false
    expect(hasCallerAuthority(context, 'manage-remote-pairing')).toBe(false)
  })

  it('grants current Task automation only the Session Plan capability', () => {
    const currentTask = createTaskCallerContext()
    const staleTask = createTaskCallerContext({ isAuthorizationCurrent: () => false })

    expect(canSatisfyHumanApproval(currentTask)).toBe(false)
    expect(canAccessSessionPlan(currentTask)).toBe(true)
    expect(canAccessSessionPlan(staleTask)).toBe(false)
  })

  it('never treats an agent-originated action as a human approval', () => {
    const context = createCallerContext({
      clientId: 'coordinator-host',
      lifecycleClientId: 'web:coordinator-host',
      leaseId: 'coordinator-host',
      surface: 'web',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'agent-session'
    })

    expect(canSatisfyHumanApproval(context)).toBe(false)
  })

  it('derives one stable context only for a real Electron sender', () => {
    const sender = { id: 7 }
    const first = callerContextForEvent({ sender })
    expect(callerContextForEvent({ sender })).toBe(first)
    expect(first.lifecycleClientId).toBe('electron:7')
  })

  it('rejects non-Electron sender ids instead of manufacturing a Web caller', () => {
    expect(() => callerContextForEvent({ sender: { id: -1 } })).toThrow(
      'Electron caller sender id must be positive.'
    )
  })
})

describe('ClientLeaseRegistry', () => {
  it('releases client-scoped resources once after the final connection closes', () => {
    const releaseClient = vi.fn()
    const registry = new ClientLeaseRegistry(releaseClient)
    const first = registry.acquire('browser-1')
    const second = registry.acquire('browser-1')

    first.release()
    first.release()
    expect(releaseClient).not.toHaveBeenCalled()

    second.release()
    second.release()
    expect(releaseClient).toHaveBeenCalledOnce()
    expect(releaseClient).toHaveBeenCalledWith('browser-1')
  })

  it('disposes each active client once and makes outstanding leases inert', () => {
    const releaseClient = vi.fn()
    const registry = new ClientLeaseRegistry(releaseClient)
    const first = registry.acquire('browser-1')
    registry.acquire('browser-1')
    const other = registry.acquire('browser-2')

    registry.dispose()
    registry.dispose()
    first.release()
    other.release()

    expect(releaseClient.mock.calls).toEqual([['browser-1'], ['browser-2']])
  })
})
