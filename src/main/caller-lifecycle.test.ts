import { describe, expect, it } from 'vitest'

import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'

describe('application caller lease registry', () => {
  it('replaces a released stable lease id with a new generation and signal', () => {
    const registry = new ApplicationCallerLeaseRegistry()
    const first = registry.acquire('web:browser-1')

    expect(first.lease).toMatchObject({ leaseId: 'web:browser-1', generation: 1 })
    expect(first.lease.signal.aborted).toBe(false)
    expect(first.lease.isCurrent()).toBe(true)

    first.release()
    expect(first.lease.signal.aborted).toBe(true)
    expect(first.lease.isCurrent()).toBe(false)

    const replacement = registry.acquire('web:browser-1')
    expect(replacement.lease.generation).toBe(2)
    expect(replacement.lease.signal).not.toBe(first.lease.signal)
    expect(replacement.lease.signal.aborted).toBe(false)
    expect(replacement.lease.isCurrent()).toBe(true)
  })

  it('prevents a stale release from aborting the replacement generation', () => {
    const registry = new ApplicationCallerLeaseRegistry()
    const first = registry.acquire('electron:7')
    const replacement = registry.acquire('electron:7')

    expect(first.lease.signal.aborted).toBe(true)
    expect(replacement.lease.isCurrent()).toBe(true)

    first.release()
    expect(replacement.lease.signal.aborted).toBe(false)
  })

  it('aborts every active lease when the surface registry is disposed', () => {
    const registry = new ApplicationCallerLeaseRegistry()
    const first = registry.acquire('electron:1')
    const second = registry.acquire('web:browser-1')

    registry.dispose()

    expect(first.lease.signal.aborted).toBe(true)
    expect(second.lease.signal.aborted).toBe(true)
    expect(() => registry.acquire('electron:2')).toThrow('registry is disposed')
  })
})
