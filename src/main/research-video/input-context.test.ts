import { expect, it } from 'vitest'
import type { ResearchVideoSessionSource } from '@aipoch/research-film'
import type { ProviderView } from '../../shared/settings'
import {
  prepareResearchFilmPrompt,
  researchFilmInputBudget,
  researchFilmTokenCounter
} from './input-context'

const provider: ProviderView = {
  id: 'provider',
  type: 'custom',
  name: 'Test',
  models: ['test'],
  supportsImageInput: false,
  hasKey: true,
  needsKey: false
}
const source: ResearchVideoSessionSource = {
  project: 'project',
  sessionTitle: 'Study',
  provenance: {
    projectId: 'project',
    sessionId: 'session',
    sourceClaimsIndependentlyVerified: false
  },
  messages: Array.from({ length: 12 }, (_, i) => ({
    i,
    id: `message-${i}`,
    role: i % 2 ? 'agent' : 'user',
    md: `Beginning ${i}: ${'中文证据🧪 with qualifications. '.repeat(50)} ${i === 3 ? '![Plot](files/plot.svg)' : ''} ${'中文证据🧪 with qualifications. '.repeat(50)} End ${i}.`,
    artifactIds: i === 3 ? ['plot-version-3'] : []
  }))
}
const count = (text: string): number => text.length

it('honors the input limit and leaves headroom without reserving the entire output ceiling', () => {
  expect(
    researchFilmInputBudget({ ...provider, contextWindow: 200_000, maxInputTokens: 100_000 })
  ).toBe(82_952)
  expect(
    researchFilmInputBudget({ ...provider, contextWindow: 100_000, maxOutputTokens: 100_000 })
  ).toBe(61_702)
  expect(researchFilmInputBudget({ ...provider, contextWindow: 1_000_000 })).toBeGreaterThan(
    800_000
  )
})

it('preserves input above 512 KiB when its estimated tokens fit', () => {
  const countTokens = researchFilmTokenCounter({
    frameworkId: 'codex',
    model: { kind: 'required', id: 'gpt-5' }
  })
  const large = {
    ...source,
    messages: [{ ...source.messages[0], md: 'Research result. '.repeat(35_000) }]
  }
  const serialized = JSON.stringify(large)
  expect(Buffer.byteLength(serialized)).toBeGreaterThan(512 * 1024)
  expect(countTokens(serialized)).toBeLessThan(150_000)
  expect(prepareResearchFilmPrompt(large, 'Instructions', 150_000, countTokens)).toBe(serialized)
})

it('prioritizes the initial question, recent exchange and Artifact evidence without renumbering or mutation', () => {
  const original = structuredClone(source)
  const prompt = prepareResearchFilmPrompt(source, 'System instructions', 2400, count)
  const projected = JSON.parse(prompt)
  expect(count(prompt) + count('System instructions')).toBeLessThanOrEqual(2400)
  expect(projected.messages.map((message: { i: number }) => message.i)).toEqual(
    expect.arrayContaining([0, 3, 10, 11])
  )
  expect(projected.messages.find((message: { i: number }) => message.i === 3).artifactIds).toEqual([
    'plot-version-3'
  ])
  expect(projected.messages.find((message: { i: number }) => message.i === 3).md).toContain(
    '![Plot](files/plot.svg)'
  )
  expect(projected.contextNote).toContain('Omitted text or messages are not evidence')
  for (const message of projected.messages) {
    expect(message.id).toBe(`message-${message.i}`)
    expect(message.md).toContain(`Beginning ${message.i}`)
    expect(message.md).toContain(`End ${message.i}.`)
    expect(message.md).toContain('[Source text omitted')
    expect(message.md.isWellFormed()).toBe(true)
  }
  expect(source).toEqual(original)
})

it('budgets correction and animation envelopes while preserving executable helpers and the frozen source', () => {
  const payload = {
    source,
    spec: { scenes: [{ msg: 3 }] },
    sharedFiles: { 'anims/helper.js': 'function draw() {}' },
    correction: {
      draft: 'invalid previous draft '.repeat(1000),
      error: 'Return a complete corrected script.'
    }
  }
  const original = structuredClone(payload)
  const prompt = prepareResearchFilmPrompt(payload, 'Animation instructions', 4000, count)
  const projected = JSON.parse(prompt)
  expect(count(prompt) + count('Animation instructions')).toBeLessThanOrEqual(4000)
  expect(projected.spec).toEqual(payload.spec)
  expect(projected.sharedFiles).toEqual(payload.sharedFiles)
  expect(projected.correction.error).toBe(payload.correction.error)
  expect(projected.correction.draft).toContain('[Source text omitted')
  expect(projected.source.messages.length).toBeGreaterThan(0)
  expect(payload).toEqual(original)
})

it('bounds replay context without losing actor identity or inventing evidence references', () => {
  const replay = {
    ...source,
    provenance: { ...source.provenance, mode: 'operation-replay' as const },
    replay: {
      schemaVersion: 1 as const,
      omissions: [],
      events: Array.from({ length: 20 }, (_, i) => ({
        id: 'e' + i,
        position: i + 1,
        messageId: 'm' + i,
        kind: i === 0 ? ('human-input' as const) : ('application-event' as const),
        title: 'Record',
        text: 'Evidence with uncertainty. '.repeat(200)
      }))
    }
  }
  const before = structuredClone(replay)
  const prompt = prepareResearchFilmPrompt({ source: replay }, 'Instructions', 2400, count)
  expect(count(prompt) + count('Instructions')).toBeLessThanOrEqual(2400)
  const selected = JSON.parse(prompt).source
  expect(selected.replay.events[0]).toMatchObject({ id: 'e0', position: 1, kind: 'human-input' })
  expect(selected.replay.events.at(-1)).toMatchObject({
    id: 'e19',
    position: 20,
    kind: 'application-event'
  })
  expect(selected.contextNote).toContain('Omitted')
  expect(replay).toEqual(before)
})

it('budgets code, output and file previews while retaining the core evidence', () => {
  const base = { messageId: 'm', title: 'Record', text: 'Evidence. '.repeat(2000) }
  const replay = {
    ...source,
    replay: {
      schemaVersion: 1 as const,
      omissions: [],
      events: [
        { ...base, id: 'question', kind: 'human-input' as const },
        ...Array.from({ length: 12 }, (_, i) => ({
          ...base,
          id: 'snapshot-' + i,
          kind: 'plan' as const
        })),
        {
          ...base,
          id: 'run',
          kind: 'execution' as const,
          execution: {
            code: 'print(42)\n'.repeat(2000),
            output: '42\n'.repeat(4000),
            language: 'python'
          }
        },
        { ...base, id: 'answer', kind: 'agent-message' as const },
        { ...base, id: 'file', kind: 'result' as const, previewText: 'Name,Value\n'.repeat(2000) }
      ]
    }
  }
  const original = structuredClone(replay)
  const prompt = prepareResearchFilmPrompt({ source: replay }, 'Instructions', 3400, count)
  const events = JSON.parse(prompt).source.replay.events
  expect(prompt.length + 'Instructions'.length).toBeLessThanOrEqual(3400)
  expect(events.map((event: { id: string }) => event.id)).toEqual(
    expect.arrayContaining(['question', 'run', 'answer', 'file'])
  )
  expect(replay).toEqual(original)
})
