import { expect, it } from 'vitest'
import { useSearchMessageFocusStore } from './search-message-focus-store'
it('keeps a newer message navigation request when an older reveal completes', () => {
  const first = { projectId: 'p', sessionId: 's', messageId: 'm1', navigationRevision: 1 }
  useSearchMessageFocusStore.getState().request(first)
  const old = useSearchMessageFocusStore.getState().pending!
  useSearchMessageFocusStore.getState().request({ ...first, messageId: 'm2' })
  useSearchMessageFocusStore.getState().consume(old)
  expect(useSearchMessageFocusStore.getState().pending?.messageId).toBe('m2')
  useSearchMessageFocusStore.getState().consume(useSearchMessageFocusStore.getState().pending!)
  expect(useSearchMessageFocusStore.getState().pending).toBeUndefined()
})
