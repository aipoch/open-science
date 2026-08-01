import { describe, expect, it } from 'vitest'

import { PendingSessionSpecialistBindings } from './pending-session-specialist-bindings'

describe('PendingSessionSpecialistBindings', () => {
  it('stashes a binding for a non-durable session and reports it pending', () => {
    const pending = new PendingSessionSpecialistBindings()
    pending.stash('s1', 'sp-1')
    expect(pending.has('s1')).toBe(true)
  })

  it('take consumes and returns the stashed binding, clearing the pending state', () => {
    const pending = new PendingSessionSpecialistBindings()
    pending.stash('s1', 'sp-1')
    expect(pending.take('s1')).toBe('sp-1')
    expect(pending.has('s1')).toBe(false)
    // A second take on the same session returns undefined (nothing pending).
    expect(pending.take('s1')).toBeUndefined()
  })

  it('stashing again overwrites (last-write-wins) before the flush', () => {
    const pending = new PendingSessionSpecialistBindings()
    pending.stash('s1', 'sp-1')
    pending.stash('s1', 'sp-2')
    expect(pending.take('s1')).toBe('sp-2')
  })

  it('stashes a cleared (Main Agent) binding as undefined and still reports it pending', () => {
    // A cleared binding (switch to Main) is a REAL flush target: the save path must clear the disk
    // binding too. So `has` is true and `take` returns undefined — the wiring keys off `has`, not the
    // returned value, to avoid dropping a clear.
    const pending = new PendingSessionSpecialistBindings()
    pending.stash('s1', undefined)
    expect(pending.has('s1')).toBe(true)
    expect(pending.take('s1')).toBeUndefined()
    expect(pending.has('s1')).toBe(false)
  })

  it('has is false for a session that was never stashed', () => {
    const pending = new PendingSessionSpecialistBindings()
    expect(pending.has('never')).toBe(false)
    expect(pending.take('never')).toBeUndefined()
  })

  it('independent sessions do not interfere', () => {
    const pending = new PendingSessionSpecialistBindings()
    pending.stash('s1', 'sp-1')
    pending.stash('s2', 'sp-2')
    expect(pending.take('s1')).toBe('sp-1')
    expect(pending.has('s2')).toBe(true)
    expect(pending.take('s2')).toBe('sp-2')
  })
})
