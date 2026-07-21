import { describe, expect, it } from 'vitest'

import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'

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
