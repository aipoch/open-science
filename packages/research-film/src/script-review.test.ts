import { expect, it, vi } from 'vitest'
import { checkFilmScript, FILM_CLOSING_LINE, scoreFilmScript } from './script-review.js'
import { buildVideoTimeline, type VideoSpec } from './timeline.js'

const spec: VideoSpec = {
  scenes: [
    {
      id: 'outro',
      role: 'outro',
      msg: 0,
      lines: [{ caption: 'The route was longer.' }, { ...FILM_CLOSING_LINE }],
      panels: [{ type: 'end_card', at: '1' }]
    }
  ]
}
const passes = {
  spine: null,
  catch: null,
  thread: null,
  audioOnly: null,
  numbers: null,
  plainWords: null,
  lineCraft: null,
  clean: null,
  true: null
}

it('requires the exact spoken close, a preceding answer, and an end card timed to that line', () => {
  const draft = structuredClone(spec)
  expect(() => checkFilmScript(draft)).not.toThrow()
  draft.scenes[0].panels[0].at = '0'
  expect(() => checkFilmScript(draft)).toThrow('end_card')
  draft.scenes[0].lines.pop()
  expect(() => checkFilmScript(draft)).toThrow('exact closing')
})
it('scores each criterion, returns precise failures, and only reuses the score for identical lines', async () => {
  const memory = new Map<string, string>()
  const checkpoint = {
    read: async (k: string) => memory.get(k),
    save: async (k: string, v: string) => {
      memory.set(k, v)
    }
  }
  const score = vi
    .fn()
    .mockResolvedValueOnce(
      JSON.stringify({ ...passes, spine: 'Answer the question in the first outro line.' })
    )
    .mockResolvedValue(JSON.stringify(passes))
  const signal = new AbortController().signal
  expect(await scoreFilmScript(spec, score, signal, checkpoint)).toEqual({
    score: 8,
    findings: ['spine: Answer the question in the first outro line.']
  })
  await scoreFilmScript(spec, score, signal, checkpoint)
  const newer = structuredClone(spec)
  newer.scenes[0].lines[0].caption = 'The fixed route was ten percent longer.'
  expect((await scoreFilmScript(newer, score, signal, checkpoint)).score).toBe(9)
  expect(score).toHaveBeenCalledTimes(2)
})
it('requires an introduction on both tracks even when the model passes all nine criteria', async () => {
  const draft = structuredClone(spec)
  draft.scenes.unshift({
    id: 'hook',
    role: 'hook',
    msg: 0,
    panels: [],
    lines: [
      { caption: "How close did the agent's route come?" },
      { caption: 'An Open-Science agent saved its route.' }
    ]
  })
  const review = (): Promise<string> => Promise.resolve(JSON.stringify(passes))
  const signal = new AbortController().signal
  expect(await scoreFilmScript(draft, review, signal)).toMatchObject({
    score: 8,
    findings: [expect.stringContaining('hook, line 0')]
  })
  draft.scenes[0].lines.pop()
  draft.scenes[0].lines[0] = {
    caption: 'How close did an Open-Science agent come?',
    say: 'How close did the agent come?'
  }
  expect((await scoreFilmScript(draft, review, signal)).score).toBe(8)
  draft.scenes[0].lines[0].say = 'How close did it come?'
  expect((await scoreFilmScript(draft, review, signal)).score).toBe(8)
  draft.scenes[0].lines = [
    { caption: 'How close did an Open-Science agent come?' },
    { caption: 'The agent saved its route.' }
  ]
  expect((await scoreFilmScript(draft, review, signal)).score).toBe(9)
})
it('breaks wide phrases for the two aspect ratios while keeping every timed word', () => {
  const draft = structuredClone(spec)
  draft.scenes[0].lines[0].caption = 'WWWWWWWW WWWWWWWW WWWWWWWW WWWWWWWW WWWWWWWW'
  const timeline = buildVideoTimeline(draft, {}, true)
  const first = timeline.captions['16x9'][0]
  expect(first.words).toHaveLength(3)
  expect(timeline.captions['9x16'][0].words).toHaveLength(1)
  expect(timeline.captions['16x9'].flatMap((p) => p.words)).toEqual(
    timeline.captions['9x16'].flatMap((p) => p.words)
  )
})
