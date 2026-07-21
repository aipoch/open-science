import { describe, expect, it } from 'vitest'

import { EnabledComputeHostsRegistry, attachEnabledComputeHosts } from './enabled-hosts-registry'

describe('EnabledComputeHostsRegistry', () => {
  it('returns an empty array for an unknown session', () => {
    const registry = new EnabledComputeHostsRegistry()

    expect(registry.get('session-1')).toEqual([])
  })

  it('stores and retrieves valid ssh: provider ids for a session', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-1', ['ssh:cluster-1', 'ssh:gpu-box'])

    expect(registry.get('session-1')).toEqual(
      expect.arrayContaining(['ssh:cluster-1', 'ssh:gpu-box'])
    )
    expect(registry.get('session-1')).toHaveLength(2)
  })

  it('keeps sessions independent', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-a', ['ssh:cluster-1'])
    registry.set('session-b', ['ssh:gpu-box'])

    expect(registry.get('session-a')).toEqual(['ssh:cluster-1'])
    expect(registry.get('session-b')).toEqual(['ssh:gpu-box'])
  })

  it('filters out invalid provider ids (non-ssh: prefix or too short)', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-1', ['ssh:valid', 'not-ssh', '', 'ssh:'])

    // 'ssh:' alone has length === 4 and is filtered out.
    expect(registry.get('session-1')).toEqual(['ssh:valid'])
  })

  it('clears the session when all provider ids are invalid', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-1', ['ssh:valid'])
    registry.set('session-1', ['invalid', 'also-bad'])

    // All invalid → registry drops the session, returns empty array.
    expect(registry.get('session-1')).toEqual([])
  })

  it('replaces the previous set on subsequent calls', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-1', ['ssh:old'])
    registry.set('session-1', ['ssh:new'])

    expect(registry.get('session-1')).toEqual(['ssh:new'])
  })

  it('clear removes the session from the registry', () => {
    const registry = new EnabledComputeHostsRegistry()

    registry.set('session-1', ['ssh:cluster-1'])
    registry.clear('session-1')

    expect(registry.get('session-1')).toEqual([])
  })

  it('clear is a no-op for unknown sessions', () => {
    const registry = new EnabledComputeHostsRegistry()

    // Should not throw.
    expect(() => registry.clear('nonexistent')).not.toThrow()
  })
})

describe('attachEnabledComputeHosts', () => {
  // Stand-in for ComputeService: methods live on the prototype, not as own properties.
  // This mirrors the real class and is exactly what a naive object spread would drop.
  class FakeComputeService {
    readonly ownField = 'i-am-own'
    async list(): Promise<string[]> {
      return ['ssh:from-prototype']
    }
    getDetails(id: string): string {
      return `details:${id}`
    }
    submitJob(): string {
      return 'submitted'
    }
  }

  it('preserves prototype methods of the wrapped service', () => {
    const service = new FakeComputeService()
    const registry = new EnabledComputeHostsRegistry()

    const augmented = attachEnabledComputeHosts(service, registry)

    // Regression guard: object spread ({...service}) would drop these prototype methods,
    // leaving them as `undefined` and breaking list/details/submit_job RPC ops.
    expect(typeof augmented.list).toBe('function')
    expect(typeof augmented.getDetails).toBe('function')
    expect(typeof augmented.submitJob).toBe('function')
  })

  it('keeps prototype methods callable with correct behavior', async () => {
    const service = new FakeComputeService()
    const registry = new EnabledComputeHostsRegistry()

    const augmented = attachEnabledComputeHosts(service, registry)

    await expect(augmented.list()).resolves.toEqual(['ssh:from-prototype'])
    expect(augmented.getDetails('ssh:x')).toBe('details:ssh:x')
    expect(augmented.submitJob()).toBe('submitted')
  })

  it('exposes getEnabledComputeHosts backed by the registry', () => {
    const service = new FakeComputeService()
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:cluster-1'])

    const augmented = attachEnabledComputeHosts(service, registry)

    expect(augmented.getEnabledComputeHosts('session-1')).toEqual(['ssh:cluster-1'])
    expect(augmented.getEnabledComputeHosts('unknown')).toEqual([])
  })

  it('preserves own properties of the wrapped service', () => {
    const service = new FakeComputeService()
    const registry = new EnabledComputeHostsRegistry()

    const augmented = attachEnabledComputeHosts(service, registry)

    expect(augmented.ownField).toBe('i-am-own')
  })

  it('does not mutate the original service instance', () => {
    const service = new FakeComputeService()
    const registry = new EnabledComputeHostsRegistry()

    const augmented = attachEnabledComputeHosts(service, registry)

    expect(augmented).not.toBe(service)
    expect('getEnabledComputeHosts' in service).toBe(false)
  })
})
