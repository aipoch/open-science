import { afterEach, describe, expect, it, vi } from 'vitest'
import { annotationTransfers, type AnnotationTransfer } from './annotation-transfer'

const item: AnnotationTransfer = {
  projectId: 'project',
  parentSessionId: 'main',
  annotation: {
    id: 'quote',
    kind: 'text',
    target: 'agent',
    quote: 'Evidence',
    source: { kind: 'agent-message', sessionId: 'main', messageId: 'message' }
  }
}
afterEach(() => annotationTransfers.cancel())
describe('annotation transfer admission', () => {
  it('removes the source only after acceptance and allows each token once', () => {
    const remove = vi.fn()
    const unregister = annotationTransfers.register('source', { read: () => item, remove })
    const token = annotationTransfers.begin('source')!
    expect(annotationTransfers.commit(token, () => false)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    const receive = vi.fn(() => true)
    expect(annotationTransfers.commit(token, receive)).toBe(true)
    expect(receive).toHaveBeenCalledWith(item)
    expect(remove).toHaveBeenCalledOnce()
    expect(annotationTransfers.commit(token, receive)).toBe(false)
    unregister()
  })
  it.each(['edited', 'unmounted', 'cancelled', 'foreign-token'] as const)(
    'rejects %s sources without removing their annotations',
    (scenario) => {
      let current = structuredClone(item)
      const remove = vi.fn()
      const unregister = annotationTransfers.register('source', { read: () => current, remove })
      const token = annotationTransfers.begin('source')!
      if (scenario === 'edited')
        current = { ...current, annotation: { ...current.annotation, note: 'Changed' } }
      if (scenario === 'unmounted') unregister()
      if (scenario === 'cancelled') annotationTransfers.cancel()
      const receive = vi.fn(() => true)
      expect(
        annotationTransfers.commit(scenario === 'foreign-token' ? 'foreign' : token, receive)
      ).toBe(false)
      expect(receive).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      unregister()
    }
  )
})
