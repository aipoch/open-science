import { describe, expect, it, vi } from 'vitest'

import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import { PptxDraftStore } from './draft-store'

const identity = (fileId: string): ManagedFileIdentity => ({
  source: 'upload',
  projectId: 'p',
  fileId
})

const input = (fileId: string, basedOnVersionId = 'v1'): Parameters<PptxDraftStore['put']>[0] => ({
  identity: identity(fileId),
  basedOnVersionId,
  operations: [],
  bytes: new Uint8Array([1]),
  summary: 'edit'
})

describe('PptxDraftStore', () => {
  it('replaces the previous draft for the same file', () => {
    const store = new PptxDraftStore()
    const first = store.put(input('f1'))
    const second = store.put(input('f1', 'v2'))
    expect(store.get(identity('f1'))?.draftId).toBe(second.draftId)
    expect(second.draftId).not.toBe(first.draftId)
  })

  it('expires drafts after the ttl and announces it', () => {
    let now = 0
    const store = new PptxDraftStore(() => now)
    const listener = vi.fn()
    store.subscribe(listener)
    store.put(input('f1'))
    now = 3 * 60 * 60 * 1000
    expect(store.get(identity('f1'))).toBeUndefined()
    expect(listener).toHaveBeenLastCalledWith({
      kind: 'cleared',
      identity: identity('f1'),
      reason: 'expired'
    })
  })

  it('clears on accept and reports whether a draft existed', () => {
    const store = new PptxDraftStore()
    store.put(input('f1'))
    expect(store.clear(identity('f1'), 'accepted')).toBe(true)
    expect(store.clear(identity('f1'), 'accepted')).toBe(false)
  })

  it('evicts the oldest draft beyond the cap', () => {
    const store = new PptxDraftStore()
    for (let index = 0; index < 17; index += 1) store.put(input(`f${index}`))
    expect(store.get(identity('f0'))).toBeUndefined()
    expect(store.get(identity('f16'))).toBeDefined()
  })
})
