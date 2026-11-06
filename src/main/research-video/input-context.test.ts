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

it('uses configured input and output limits rather than a fixed conversation byte cap', () => {
  expect(
    researchFilmInputBudget({ ...provider, contextWindow: 200_000, maxInputTokens: 100_000 })
  ).toBe(82_952)
  expect(
    researchFilmInputBudget({ ...provider, contextWindow: 100_000, maxOutputTokens: 32_000 })
  ).toBe(55_752)
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
