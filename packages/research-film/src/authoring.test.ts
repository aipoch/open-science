import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import {
  authorResearchFilmSource,
  createResearchFilmAuthor,
  generateResearchFilm,
  type ResearchFilmAuthor
} from './authoring.js'
import { buildVideoTimeline, type VideoPanel, type VideoSpec } from './timeline.js'
import { parseResearchVideoScreenplay } from './screenplay.js'
import { ResearchFilmOutputLimitError } from './authoring-correction.js'
import { FILM_CLOSING_LINE } from './script-review.js'

const source = {
  sessionTitle: 'Evidence',
  project: 'p',
  messages: [
    { i: 0, id: 'm', role: 'assistant', md: 'Evidence remains uncertain.', artifactIds: [] }
  ],
  provenance: { projectId: 'p', sessionId: 's', sourceClaimsIndependentlyVerified: false }
}
const spec = {
  version: 1,
  case: 'evidence',
  title: 'Evidence',
  session: 'session.json',
  scenes: [
    {
      id: 'hook',
      role: 'hook',
      msg: 0,
      lines: [{ caption: 'Evidence remains uncertain.' }],
      panels: [
        { type: 'title', text: 'Evidence' },
        { type: 'animation', script: 'anims/hook.js', size: 'band' }
      ]
    },
    {
      id: 'outro',
      role: 'outro',
      msg: 0,
      lines: [{ caption: 'Made with Open-Science.' }],
      panels: [{ type: 'end_card' }]
    }
  ]
}

it('repairs the faulty drawing, reuses good units, and checks the rebuilt HTML before returning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'film-html-review-'))
  try {
    const story = {
      ...spec,
      scenes: [
        spec.scenes[0],
        {
          ...spec.scenes[0],
          id: 'result',
          role: 'result',
          panels: [{ type: 'animation', script: 'anims/result.js' }]
        },
        spec.scenes[1]
      ]
    }
    const writeScreenplay = vi.fn(async () => JSON.stringify(story))
    const writeAnimation = vi.fn<
      NonNullable<Parameters<typeof generateResearchFilm>[0]['author']['writeAnimation']>
    >(async (_source, input, _signal, correction) =>
      correction ? 'k.ctx.fillRect(2,2,40,40)' : `// ${input.path}`
    )
    const generate = vi.fn(async () => ({
      playerPath: 'player.html',
      sourcePath: 'sources.zip',
      duration: 4,
      preparationMs: 2
    }))
    const issue = { scene: 'result', script: 'anims/result.js', message: 'Two labels overlap' }
    const reviewPlayer = vi.fn().mockResolvedValueOnce([issue]).mockResolvedValueOnce([])
    await generateResearchFilm({
      source,
      directory,
      author: { writeScreenplay, writeAnimation },
      generate,
      reviewPlayer,
      signal: new AbortController().signal,
      modelDirectory: 'model',
      engineDirectory: 'engine',
      modelRevision: 'v'
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(reviewPlayer).toHaveBeenCalledTimes(2)
    expect(writeScreenplay).toHaveBeenCalledOnce()
    expect(writeAnimation).toHaveBeenCalledTimes(3)
    expect(writeAnimation.mock.lastCall?.[3]).toEqual({
      draft: '// anims/result.js',
      error: expect.stringContaining(issue.message)
    })
    expect(await readFile(join(directory, 'anims/result.js'), 'utf8')).toContain('fillRect')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('replaces a failed session app with a drawing and rechecks later repairs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'film-app-fallback-'))
  try {
    const writeScreenplay = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...spec, libs: ['libs/app.js'] }))
      .mockResolvedValue(JSON.stringify(spec))
    const writeAnimation = vi.fn().mockResolvedValue('k.ctx.fillRect(0,0,40,40)')
    const reviewPlayer = vi
      .fn()
      .mockResolvedValueOnce([
        { scene: 'hook', app: true, message: 'The approved app did not run.' }
      ])
      .mockResolvedValueOnce([
        { scene: 'hook', script: 'anims/hook.js', message: 'Move the label.' }
      ])
      .mockResolvedValueOnce([])
    const result = await generateResearchFilm({
      source: {
        ...source,
        sessionApp: { name: 'orbit.zip', modules: 1, api: ['position(t)'], packages: [] }
      },
      directory,
      author: { writeScreenplay, writeAnimation },
      reviewPlayer,
      generate: async () => ({
        playerPath: 'player.html',
        sourcePath: 'sources.zip',
        duration: 2,
        preparationMs: 1
      }),
      signal: new AbortController().signal,
      modelDirectory: 'model',
      modelRevision: 'v',
      engineDirectory: 'engine'
    })
    expect(result.usedSessionApp).toBe(false)
    expect(writeScreenplay).toHaveBeenCalledTimes(2)
    expect(writeScreenplay.mock.calls[1][2].error).toContain('Omit libs')
    expect(writeAnimation).toHaveBeenCalledTimes(3)
    expect(reviewPlayer).toHaveBeenCalledTimes(3)
    expect(JSON.parse(await readFile(join(directory, 'video.json'), 'utf8'))).not.toHaveProperty(
      'libs'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('repairs only the reported layout and preserves the narration and existing drawings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'film-layout-repair-'))
  try {
    const replacement = structuredClone(spec)
    replacement.scenes[0].lines[0].caption = 'Unrequested new narration.'
    replacement.scenes[0].panels[0].text = 'Readable title'
    replacement.scenes[1].lines[0].caption = 'Unrequested change in a good scene.'
    const writeScreenplay = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(spec))
      .mockResolvedValueOnce('{')
      .mockResolvedValueOnce(JSON.stringify(replacement))
    const writeAnimation = vi.fn(async () => '// original drawing')
    const reviewPlayer = vi
      .fn()
      .mockResolvedValueOnce([{ scene: 'hook', message: 'The title overlaps a panel.' }])
      .mockResolvedValueOnce([])
    await generateResearchFilm({
      source,
      directory,
      author: { writeScreenplay, writeAnimation },
      reviewPlayer,
      generate: async () => ({
        playerPath: 'player.html',
        sourcePath: 'sources.zip',
        duration: 4,
        preparationMs: 1
      }),
      signal: new AbortController().signal,
      modelDirectory: 'model',
      engineDirectory: 'engine',
      modelRevision: 'v'
    })
    const repaired = JSON.parse(await readFile(join(directory, 'video.json'), 'utf8'))
    expect(repaired.scenes[0].lines).toEqual(spec.scenes[0].lines)
    expect(repaired.scenes[0].panels[0].text).toBe('Readable title')
    expect(repaired.scenes[1]).toEqual(spec.scenes[1])
    expect(writeAnimation).toHaveBeenCalledOnce()
    expect(reviewPlayer).toHaveBeenCalledTimes(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves repaired visuals while applying later narration and cue corrections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'film-layout-narration-'))
  try {
    const original: VideoSpec = {
      ...spec,
      scenes: [
        spec.scenes[0],
        {
          id: 'result',
          role: 'result',
          msg: 0,
          lines: [{ caption: 'The evidence remains uncertain.' }],
          panels: [
            {
              type: 'stats',
              total: 'Total',
              total_at: '0:uncertain',
              items: [{ value: '?', label: 'Evidence', at: '0:uncertain' }]
            },
            {
              type: 'compare',
              left: { title: 'Claim' },
              right: { title: 'Evidence', at: '0:uncertain' }
            }
          ]
        },
        {
          ...spec.scenes[1],
          lines: [{ caption: 'The evidence is uncertain.' }, { ...FILM_CLOSING_LINE }],
          panels: [
            { type: 'title', text: 'Keep the qualification', until: '1' },
            { type: 'end_card', at: '1' }
          ]
        }
      ]
    }
    const repaired = structuredClone(original)
    repaired.scenes[0].panels[0].text = 'Readable title'
    repaired.scenes[0].lines[0].caption = 'Evidence?'
    const rewritten = structuredClone(original)
    rewritten.scenes[0].lines = [{ caption: 'What does the evidence establish?' }]
    rewritten.scenes[1].lines = [{ caption: 'The evidence is inconclusive.' }]
    rewritten.scenes[1].panels[0].total_at = '0:inconclusive'
    rewritten.scenes[1].panels[0].items![0].at = '0:inconclusive'
    rewritten.scenes[1].panels[0].items![0].value = 'Unrequested new value'
    rewritten.scenes[1].panels[1].right!.at = '0:inconclusive'
    rewritten.scenes[1].panels[1].right!.title = 'Unrequested new label'
    rewritten.scenes[2].lines.unshift({ caption: 'The result needs another check.' })
    rewritten.scenes[2].panels[0].until = '2'
    rewritten.scenes[2].panels[1].at = '2'
    const memory = new Map([['screenplay', JSON.stringify(original)]])
    const checkpoint = {
      read: async (key: string) => memory.get(key),
      save: async (key: string, value: string) => {
        memory.set(key, value)
      }
    }
    const writeScreenplay = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(repaired))
      .mockResolvedValue(JSON.stringify(rewritten))
    const reviewScript = vi.fn<NonNullable<ResearchFilmAuthor['reviewScript']>>(
      async (_source, narration) =>
        JSON.stringify({
          spine:
            narration[0].lines[0].caption === repaired.scenes[0].lines[0].caption
              ? 'Ask a clear opening question.'
              : null,
          catch: null,
          thread: null,
          audioOnly: null,
          numbers: null,
          plainWords: null,
          lineCraft: null,
          clean: null,
          true: null
        })
    )
    const generate = vi.fn(async () => ({
      playerPath: 'player.html',
      sourcePath: 'sources.zip',
      duration: 4,
      preparationMs: 1
    }))
    const reviewPlayer = vi
      .fn()
      .mockResolvedValueOnce([
        { scene: 'hook', line: 0, message: 'Make the title and opening caption fit.' }
      ])
      .mockResolvedValueOnce([])
    const result = await generateResearchFilm({
      source,
      directory,
      author: { writeScreenplay, reviewScript, writeAnimation: async () => '// drawing' },
      checkpoint,
      generate,
      reviewPlayer,
      signal: new AbortController().signal,
      modelDirectory: 'model',
      engineDirectory: 'engine',
      modelRevision: 'v'
    })
    const saved = JSON.parse(await readFile(join(directory, 'video.json'), 'utf8')) as VideoSpec
    expect(saved.scenes[0].panels).toEqual(repaired.scenes[0].panels)
    expect(saved.scenes.map((scene) => scene.lines)).toEqual(
      rewritten.scenes.map((scene) => scene.lines)
    )
    expect(saved.scenes[1].panels[0].items).toEqual([
      { value: '?', label: 'Evidence', at: '0:inconclusive' }
    ])
    expect(saved.scenes[1].panels[1].right).toEqual({ title: 'Evidence', at: '0:inconclusive' })
    expect(saved.scenes[2].panels).toEqual(rewritten.scenes[2].panels)
    expect(JSON.parse(memory.get('screenplay')!)).toMatchObject({ scenes: saved.scenes })
    expect(JSON.parse(writeScreenplay.mock.calls[1][2].draft).scenes[0].panels).toEqual(
      repaired.scenes[0].panels
    )
    expect(writeScreenplay).toHaveBeenCalledTimes(2)
    expect(reviewScript).toHaveBeenCalledTimes(3)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(reviewPlayer).toHaveBeenCalledTimes(2)
    expect(result.scriptScore).toBe(9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses the default comparison reveal for malformed timing while preserving content validation', () => {
  const parse = (right: Record<string, unknown>): VideoPanel =>
    parseResearchVideoScreenplay(
      JSON.stringify({
        ...spec,
        scenes: [
          spec.scenes[0],
          {
            ...spec.scenes[0],
            id: 'result',
            role: 'result',
            panels: [{ type: 'compare', left: { title: 'Before' }, right, verdict: 'Uncertain' }]
          }
        ]
      }),
      1
    ).scenes[1].panels[0]
  const fallback = parse({ title: 'After', at: 'after the first line' })
  expect(fallback).toMatchObject({
    left: { title: 'Before' },
    right: { title: 'After' },
    verdict: 'Uncertain'
  })
  expect(fallback.right).not.toHaveProperty('at')
  expect(parse({ title: 'After', at: '0' }).right?.at).toBe('0')
  expect(() => parse({ at: 'after the first line' })).toThrow()
})

it('preserves a long verdict and gives its remaining pages time before the next narration', () => {
  const text = 'The measured difference remains uncertain. '.repeat(8) + '不能据此得出因果结论。'
  const scenes = [
    spec.scenes[0],
    {
      ...spec.scenes[0],
      id: 'result',
      role: 'result',
      panels: [{ type: 'verdict', text, tone: 'muted', until: '0.end' }]
    },
    { ...spec.scenes[0], id: 'outro', role: 'outro', panels: [{ type: 'end_card' }] }
  ]
  const parsed = parseResearchVideoScreenplay(JSON.stringify({ ...spec, scenes }), 1)
  expect(parsed.scenes[1].panels[0].text).toBe(text)
  const timeline = buildVideoTimeline(parsed, {}, true)
  const [, result, outro] = timeline.scenes
  const [first, continuation] = result.panels
  expect(first.t_out).toBe(result.lines[0].t1)
  expect(continuation.t_in).toBeGreaterThan(first.t_out!)
  expect(continuation).toMatchObject({
    text,
    t_out: result.dur,
    reading: { offset: first.t_out! - first.t_in }
  })
  expect(outro.start).toBeCloseTo(result.start + result.dur, 3)
  expect(timeline.captions['16x9'].at(-1)!.words[0][1]).toBeCloseTo(
    outro.start + outro.lines[0].t0,
    3
  )
})

it.each([false, true])(
  'bounds screenplay correction before worker generation (valid correction: %s)',
  async (valid) => {
    const directory = await mkdtemp(join(tmpdir(), 'film-authoring-'))
    try {
      const writeScreenplay = vi
        .fn()
        .mockResolvedValueOnce('invalid')
        .mockResolvedValue(valid ? JSON.stringify(spec) : '{}')
      const writeAnimation = vi.fn(async () => 'k.ctx.fillRect(0, 0, 1, 1);')
      const generate = vi.fn(async () => ({
        playerPath: 'player.html',
        sourcePath: 'sources.zip',
        duration: 1,
        preparationMs: 1
      }))
      const run = generateResearchFilm({
        source,
        directory,
        author: { writeScreenplay, writeAnimation },
        generate,
        signal: new AbortController().signal,
        modelDirectory: 'model',
        modelRevision: 'revision',
        engineDirectory: 'engine'
      })
      if (valid) {
        expect(await run).toMatchObject({ title: 'Evidence', duration: 1 })
        expect(JSON.parse(await readFile(join(directory, 'video.json'), 'utf8'))).toMatchObject(
          spec
        )
        expect(generate.mock.calls).toHaveLength(1)
        expect(writeAnimation).toHaveBeenCalledOnce()
      } else {
        await expect(run).rejects.toThrow()
        expect(generate).not.toHaveBeenCalled()
        expect(writeAnimation).not.toHaveBeenCalled()
      }
      expect(writeScreenplay).toHaveBeenCalledTimes(2)
      expect(writeScreenplay.mock.calls[1][2]).toMatchObject({
        draft: 'invalid',
        error: expect.any(String)
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.each(['truncated', 'paths', 'assets', 'missing-file', 'missing-outro', 'missing-card'])(
  'repairs %s screenplay output before animation authoring',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'film-authoring-'))
    try {
      const invalid = structuredClone(spec)
      if (failure === 'missing-outro') invalid.scenes.pop()
      if (failure === 'missing-card') invalid.scenes[1].panels = [{ type: 'title', text: 'End' }]
      if (failure === 'paths') invalid.scenes[0].panels[1].script = '../escape.js'
      if (failure === 'assets')
        Object.assign(invalid, { libs: ['https://example.test/library.js'] })
      if (failure === 'missing-file') Object.assign(invalid.scenes[0], { file: 'missing.png' })
      const writeScreenplay = vi.fn().mockResolvedValue(JSON.stringify(spec))
      if (failure === 'truncated')
        writeScreenplay.mockRejectedValueOnce(new ResearchFilmOutputLimitError('output limit'))
      else writeScreenplay.mockResolvedValueOnce(JSON.stringify(invalid))
      const writeAnimation = vi.fn(async () => 'k.ctx.fillRect(0, 0, 1, 1);')
      await authorResearchFilmSource({
        source,
        directory,
        author: { writeScreenplay, writeAnimation },
        signal: new AbortController().signal
      })
      expect(writeScreenplay).toHaveBeenCalledTimes(2)
      expect(writeAnimation).toHaveBeenCalledOnce()
      expect(writeScreenplay.mock.calls[1][2]).toMatchObject({ error: expect.any(String) })
      expect(JSON.stringify(writeScreenplay.mock.calls[1][2])).not.toContain(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.each([false, true])('handles staged asset storage (invalid directory: %s)', async (invalid) => {
  const directory = await mkdtemp(join(tmpdir(), 'film-assets-'))
  try {
    if (invalid) await writeFile(join(directory, 'files'), 'not a directory')
    else {
      await mkdir(join(directory, 'files', 'figures'), { recursive: true })
      await writeFile(join(directory, 'files', 'figures', 'plot.png'), 'image bytes')
    }
    const screenplay = structuredClone(spec)
    Object.assign(screenplay.scenes[0], { file: 'figures/plot.png' })
    const writeScreenplay = vi.fn(async () => JSON.stringify(screenplay))
    const run = authorResearchFilmSource({
      source,
      directory,
      signal: new AbortController().signal,
      author: { writeScreenplay, writeAnimation: async () => 'k.ctx.fillRect(0, 0, 1, 1);' }
    })
    if (invalid) {
      await expect(run).rejects.toMatchObject({ code: 'ENOTDIR' })
      expect(writeScreenplay).not.toHaveBeenCalled()
    } else {
      await run
      expect(writeScreenplay).toHaveBeenCalledOnce()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['scene', 'helper', 'file-citation'])(
  'preserves referenced animation evidence and original message indices: %s',
  async (kind) => {
    const shared = kind === 'helper'
    const infer = vi.fn(async () => 'code')
    const author = createResearchFilmAuthor(infer)
    const complete = {
      ...source,
      messages: [
        source.messages[0],
        { ...source.messages[0], i: 7, id: 'other', md: 'Scene question' },
        { ...source.messages[0], i: 11, id: 'measurement', md: 'Reported measurement: 42' },
        { ...source.messages[0], i: 13, id: 'result', artifactIds: ['artifact-result'] },
        {
          ...source.messages[0],
          i: 15,
          id: 'figure',
          md: '![Measurement](files/plot-123.png)',
          artifactIds: ['artifact-figure']
        },
        { ...source.messages[0], i: 19, id: 'unrelated', md: 'Unrelated evidence' }
      ]
    }
    const screenplay = {
      ...spec,
      scenes: [
        spec.scenes[0],
        {
          ...spec.scenes[0],
          id: 'other',
          msg: 7,
          cite: kind === 'file-citation' ? ['files/plot-123.png'] : [11, 'm', 'artifact-result'],
          panels: [{ type: 'animation', script: 'anims/other.js', use: ['anims/other-helper.js'] }]
        }
      ]
    }
    await author.writeAnimation!(
      complete,
      {
        path: shared ? 'anims/other-helper.js' : 'anims/other.js',
        shared,
        spec: screenplay,
        sharedFiles: { 'anims/other-helper.js': 'needed', 'anims/unrelated.js': 'omit' }
      },
      new AbortController().signal
    )
    expect(infer.mock.calls[0][0]).toBe(complete)
    expect(infer.mock.calls[0][2]).toMatchObject({
      source: {
        messages: kind === 'file-citation' ? complete.messages : complete.messages.slice(0, 4)
      },
      spec: { scenes: [screenplay.scenes[1]] },
      sharedFiles: { 'anims/other-helper.js': 'needed' }
    })
    expect(JSON.stringify(infer.mock.calls[0][2])).not.toContain('anims/unrelated.js')
  }
)
