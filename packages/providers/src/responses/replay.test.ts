import { expect, it } from 'vitest'
import { ReasoningReplay } from './replay'
it('fails closed without a Session scope and bounds cached reasoning by LRU Session', () => {
  type ReasoningCacheHarness = {
    record: (promptCacheKey: string | undefined, reasoning: string, callIds: string[]) => void
    reconcile: (promptCacheKey: string | undefined, input: unknown) => void
    reasoningByPromptCacheKey: Map<string, Map<string, { text: string }>>
    reasoningCacheEntryCount: number
    reasoningCacheCharacterCount: number
  }
  const harness = (options: {
    reasoningCacheMaxEntries: number
    reasoningCacheMaxCharacters: number
  }): ReasoningCacheHarness => new ReasoningReplay(options) as unknown as ReasoningCacheHarness
  const fill = (cache: ReasoningCacheHarness): void => {
    cache.record(undefined, 'unsafe', ['unscoped-call'])
    cache.record('session-a', 'aaa', ['call-a'])
    cache.record('session-b', 'bbb', ['call-b'])
    cache.record('session-c', 'ccc', ['call-c'])
  }

  const entryBounded = harness({
    reasoningCacheMaxEntries: 2,
    reasoningCacheMaxCharacters: 100
  })
  fill(entryBounded)
  expect([...entryBounded.reasoningByPromptCacheKey.keys()]).toEqual(['session-b', 'session-c'])
  expect(entryBounded.reasoningCacheEntryCount).toBe(2)

  const characterBounded = harness({
    reasoningCacheMaxEntries: 100,
    reasoningCacheMaxCharacters: 6
  })
  fill(characterBounded)
  expect([...characterBounded.reasoningByPromptCacheKey.keys()]).toEqual(['session-b', 'session-c'])
  expect(characterBounded.reasoningCacheCharacterCount).toBe(6)

  const reconciled = harness({
    reasoningCacheMaxEntries: 100,
    reasoningCacheMaxCharacters: 100
  })
  reconciled.record('session-a', 'aaa', ['retained-call', 'compacted-call'])
  reconciled.reconcile('session-a', [{ type: 'function_call', call_id: 'retained-call' }])
  expect(reconciled.reasoningByPromptCacheKey.get('session-a')).toEqual(
    new Map([[JSON.stringify(['function_call', 'retained-call']), { text: 'aaa' }]])
  )
  expect(reconciled.reasoningCacheEntryCount).toBe(1)
  expect(reconciled.reasoningCacheCharacterCount).toBe(3)
})
