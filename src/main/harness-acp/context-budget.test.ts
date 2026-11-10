import { describe, expect, it } from 'vitest'
import type { AgentMessage, ModelRequest } from '@aipoch/agent-harness'

import { createContextMeter, createToolResultClearing } from './agent'

const request = (id: string, messages: AgentMessage[]): ModelRequest => ({
  requestId: id,
  instructions: 'x'.repeat(40_000),
  tools: [],
  messages,
  maxOutputTokens: 1024
})
const user = (id: string, text: string): AgentMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }]
})
const exchange = (index: number, size: number): AgentMessage[] => [
  {
    id: `a${index}`,
    role: 'assistant',
    content: [],
    calls: [{ id: `c${index}`, name: 'tool', arguments: {} }]
  },
  {
    id: `t${index}`,
    role: 'tool',
    invocationId: `a${index}/c${index}`,
    content: [{ type: 'text', text: 'r'.repeat(size) }]
  }
]

describe('context meter', () => {
  it('reuses the reported prefix and estimates only appended messages conservatively', () => {
    const meter = createContextMeter()
    const first = request('r1', [user('u1', 'hello')])
    meter.admitted(first)
    meter.reported('r1', { inputTokens: 10_000, outputTokens: 10 })

    const appended = 'y'.repeat(8_000)
    const next = request('r2', [...first.messages, user('u2', appended)])
    const delta = meter.measure(next) - 10_000
    const deltaBytes = Buffer.byteLength(JSON.stringify(next.messages[1]))
    expect(delta).toBeGreaterThan(Math.ceil(deltaBytes / 4))

    // A changed prefix cannot reuse the report and falls back to the calibrated whole estimate.
    const changed = request('r3', [user('u1', 'edited'), next.messages[1]])
    expect(meter.measure(changed)).toBeLessThan(meter.measure(next))
  })

  it('ignores implausible usage and prices an overflow rejection above the window', () => {
    const meter = createContextMeter()
    const rejected = request('r1', [user('u1', 'z'.repeat(80_000))])
    meter.admitted(rejected)
    meter.reported('r1', { inputTokens: 100, outputTokens: 1 })
    expect(meter.measure(rejected)).toBeGreaterThan(20_000)

    meter.admitted(rejected)
    meter.overflowed(16_000)
    expect(meter.measure(rejected)).toBeGreaterThan(16_000)
    expect(meter.measure(request('r2', [user('u1', 'short')]))).toBeLessThan(16_000 * 0.9)
  })

  it('prices a rejected compaction summary after the main request was reported', () => {
    const meter = createContextMeter()
    meter.admitted(request('r1', [user('u1', 'hello')]))
    meter.reported('r1', { inputTokens: 10_000, outputTokens: 10 })

    const summary = request('s1', [user('u1', 'hello'), user('u2', 'summarize')])
    expect(meter.measure(summary)).toBeLessThan(16_000)
    meter.summarizing(summary)
    meter.overflowed(16_000)
    expect(meter.measure(summary)).toBeGreaterThan(16_000)
  })
})

describe('tool result clearing', () => {
  it('keeps recent results, clears older large ones by reference, and stays cleared', () => {
    const meter = createContextMeter()
    const messages = [
      user('u', 'go'),
      ...Array.from({ length: 10 }, (_, i) => exchange(i, 8_000)).flat()
    ]
    meter.admitted(request('r', messages))
    const clearing = createToolResultClearing(40_000, meter)

    const view = clearing.project(messages)
    const results = view.filter((message) => message.role === 'tool')
    const cleared = results.filter((message) =>
      JSON.stringify(message.content).includes('read_tool_result')
    )
    expect(cleared.length).toBeGreaterThan(0)
    expect(results.slice(-6).every((message) => !cleared.includes(message))).toBe(true)
    expect(JSON.stringify(cleared[0].content)).toContain('invocationId=\\"a0/c0\\"')
    expect(messages[2].content[0]).toEqual({ type: 'text', text: 'r'.repeat(8_000) })

    // A later, smaller history keeps the earlier batch cleared so the projected prefix is stable.
    const again = clearing.project(messages.slice(0, 5))
    expect(JSON.stringify(again[2].content)).toContain('read_tool_result')
  })

  it('keeps old results that contain media, which read_tool_result cannot return', () => {
    const meter = createContextMeter()
    const exchanges = Array.from({ length: 10 }, (_, i) => exchange(i, 8_000))
    exchanges[0][1].content.push({
      type: 'image',
      mimeType: 'image/png',
      source: 'data:image/png;base64,AA=='
    })
    const messages = [user('u', 'go'), ...exchanges.flat()]
    meter.admitted(request('r', messages))

    const view = createToolResultClearing(40_000, meter).project(messages)

    expect(view[2]).toBe(messages[2])
    expect(JSON.stringify(view[4].content)).toContain('read_tool_result')
  })
})
