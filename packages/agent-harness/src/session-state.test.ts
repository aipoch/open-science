import { describe, expect, it, vi } from 'vitest'
import {
  checkState,
  contextItems,
  json,
  projectedItems,
  projectedMessages,
  seal
} from './session-state'
import type { AgentCheckpoint, AgentMessage } from './session-types'

const message = (id: string, role: AgentMessage['role'] = 'user'): AgentMessage => ({
  id,
  role,
  content: [{ type: 'text', text: id }]
})
const fixture = (): AgentCheckpoint => ({
  version: 1,
  sessionId: 's',
  revision: 0,
  requests: [],
  pending: [],
  compactions: [],
  messages: [
    message('u'),
    {
      ...message('a', 'assistant'),
      calls: [
        { id: 'one', name: 'work', arguments: {} },
        { id: 'two', name: 'work', arguments: {} }
      ]
    },
    { ...message('r1', 'tool'), invocationId: 'a/one' },
    { ...message('r2', 'tool'), invocationId: 'a/two' },
    message('answer', 'assistant'),
    message('next'),
    message('final', 'assistant')
  ]
})

it('rejects altered preserved user input and non-tool or media-changing previews', () => {
  const state = fixture()
  state.compactions = [
    {
      sourceIds: ['u', 'a:call:0', 'a:call:1', 'r1', 'r2'],
      summary: message('summary', 'summary'),
      preservedUserMessages: [state.messages[0]]
    }
  ]
  expect(() => checkState(state, 's')).not.toThrow()
  expect(projectedMessages(state).map((message) => message.id)).toEqual([
    'summary',
    'u',
    'answer',
    'next',
    'final'
  ])
  state.compactions[0].preservedUserMessages = [
    { ...state.messages[0], content: [{ type: 'text', text: 'changed authority' }] }
  ]
  expect(() => checkState(state, 's')).toThrow('Invalid preserved user message')
  const invalid = fixture()
  invalid.messages[0].modelContent = [{ type: 'text', text: 'preview' }]
  expect(() => checkState(invalid, 's')).toThrow('Only tool results')
  delete invalid.messages[0].modelContent
  invalid.messages[2].content.push({ type: 'image', mimeType: 'image/png', source: 'original' })
  invalid.messages[2].modelContent = [{ type: 'text', text: 'discarded image' }]
  expect(() => checkState(invalid, 's')).toThrow('preserve media')
})

describe('immutable JSON validation', () => {
  it('validates shared immutable history once while checking each new revision', () => {
    const history = seal({ text: 'archived evidence' })
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors')
    try {
      json({ history, revision: 0 })
      json({ history, revision: 1 })
      expect(descriptors.mock.calls.filter(([value]) => value === history)).toHaveLength(1)
      expect(() => json({ history, revision: NaN })).toThrow('Expected acyclic JSON')
    } finally {
      descriptors.mockRestore()
    }
  })

  it('does not trust a host-frozen parent or memoize mutable children', () => {
    const child = { value: 1 }
    const host = Object.freeze({ child })
    json(host)
    child.value = Infinity
    expect(() => json(host)).toThrow('Expected acyclic JSON')
    child.value = 2
    json(host)
  })

  it.each([
    { value: undefined },
    { value: Infinity },
    { value: new Date(0) },
    { value: new Array(2) },
    { [Symbol('hidden')]: 'value' }
  ])('never memoizes an invalid owned graph %#', (value) => {
    const owned = seal(value)
    expect(() => json(owned)).toThrow()
    expect(() => json(owned)).toThrow()
  })

  it('still rejects cycles, accessors and invalid checkpoint semantics after valid JSON', () => {
    const cycle: { child?: unknown } = {}
    cycle.child = cycle
    expect(() => json(cycle)).toThrow('Expected acyclic JSON')
    const getter = vi.fn(() => 1)
    const accessor = Object.freeze(Object.defineProperty({}, 'value', { get: getter }))
    expect(() => json(accessor)).toThrow('Expected JSON without accessors')
    expect(getter).not.toHaveBeenCalled()
    const state = seal({ ...fixture(), revision: -1 })
    json(state)
    expect(() => checkState(state, 's')).toThrow('Invalid agent checkpoint')
    expect(() => checkState(state, 's')).toThrow('Invalid agent checkpoint')
  })
})

// Previous full-history projection, retained only as a differential oracle for boundary semantics.
function original(state: AgentCheckpoint): ReturnType<typeof contextItems> {
  let items = contextItems(state.messages)
  for (const { sourceIds, summary } of state.compactions) {
    if (!sourceIds.length || sourceIds.some((id, i) => items[i]?.id !== id))
      throw new Error('prefix')
    const pending = new Set<string>()
    for (const item of items.slice(0, sourceIds.length)) {
      if (item.kind === 'tool-call') pending.add(item.callId)
      if (item.kind === 'tool-result' && !pending.delete(item.callId)) throw new Error('orphan')
    }
    if (pending.size) throw new Error('split')
    items = [...contextItems([summary]), ...items.slice(sourceIds.length)]
  }
  return items
}

describe('active history projection', () => {
  it('matches full replay across every first and nested compaction boundary', () => {
    const state = fixture()
    const initial = contextItems(state.messages)
    for (let end = 1; end <= initial.length; end++) {
      state.compactions = [
        { sourceIds: initial.slice(0, end).map((i) => i.id), summary: message('s1', 'summary') }
      ]
      if (end >= 2 && end <= 4) {
        expect(() => projectedItems(state)).toThrow('splits a tool exchange')
        continue
      }
      const first = original(state)
      expect(projectedItems(state)).toEqual(first)
      for (let nextEnd = 1; nextEnd <= first.length; nextEnd++) {
        state.compactions.push({
          sourceIds: first.slice(0, nextEnd).map((i) => i.id),
          summary: message('s2', 'summary')
        })
        try {
          let expected: ReturnType<typeof original>
          try {
            expected = original(state)
          } catch {
            expect(() => projectedItems(state)).toThrow()
            continue
          }
          expect(projectedItems(state)).toEqual(expected)
          checkState(state, 's')
        } finally {
          state.compactions.pop()
        }
      }
    }
  })

  it('validates archived bodies without encoding them or superseded summaries', () => {
    const state = fixture()
    state.compactions = [
      { sourceIds: ['u', 'a:call:0', 'a:call:1', 'r1', 'r2'], summary: message('s1', 'summary') },
      { sourceIds: ['s1', 'answer'], summary: message('s2', 'summary') }
    ]
    const archived = new Set([...state.messages.slice(0, 5), state.compactions[0].summary])
    const stringify = JSON.stringify
    const encoded: unknown[] = []
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...rest) => {
      encoded.push(value)
      return stringify(value, ...rest)
    })
    try {
      checkState(state, 's')
      expect(projectedMessages(state).map((m) => m.id)).toEqual(['s2', 'next', 'final'])
      expect(projectedItems(state)).toHaveLength(3)
      expect(encoded.some((value) => archived.has(value as AgentMessage))).toBe(false)
      state.messages[0].content = [
        { type: 'text', text: 1 } as unknown as AgentMessage['content'][number]
      ]
      expect(() => checkState(state, 's')).toThrow('Invalid content block')
    } finally {
      spy.mockRestore()
    }
  })

  it.each([[], ['missing'], ['a:call:0'], ['u', 'r1']].map((sourceIds) => ({ sourceIds })))(
    'rejects corrupt compacted prefixes $sourceIds',
    ({ sourceIds }) => {
      const state = fixture()
      state.compactions.push({ sourceIds, summary: message('s', 'summary') })
      expect(() => checkState(state, 's')).toThrow('Invalid compaction prefix')
    }
  )
})
