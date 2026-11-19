import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { unzipSync } from 'fflate'
import { parseReplayCase } from './replay-case.js'
import { authorResearchFilmSource, createResearchFilmAuthor } from './authoring.js'
import { buildReplayPlayer, freezeReplaySource } from './replay-player.js'
import { researchFilmResources } from './resources.js'
import type { ResearchVideoSessionSource } from './source.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const source: ResearchVideoSessionSource = {
  sessionTitle: 'Recorded experiment',
  project: 'p',
  messages: [],
  provenance: {
    projectId: 'p',
    sessionId: 's',
    mode: 'operation-replay',
    sourceClaimsIndependentlyVerified: false
  },
  replay: {
    schemaVersion: 1,
    omissions: ['Some historical execution records have no reliable provenance.'],
    events: [
      {
        id: 'm1',
        messageId: 'm1',
        kind: 'human-input',
        title: 'Question',
        text: 'Study rainfall.'
      },
      {
        id: 'm2',
        messageId: 'm2',
        kind: 'application-event',
        title: 'Application event',
        text: '<script>window.compromised=true</script>'
      }
    ]
  }
}
const narration =
  'The user asked about rainfall. The application then supplied context automatically; this record does not establish another human action or a successful analysis.'
const spec = {
  schemaVersion: 1,
  title: 'Evidence',
  scenes: [{ id: 's1', evidenceIds: ['m1', 'm2'], narration }]
}
it('rejects invented, duplicated or reversed evidence and executable case fields', () => {
  expect(parseReplayCase(JSON.stringify(spec), source)).toEqual(spec)
  expect(
    parseReplayCase('```json\n' + JSON.stringify(spec) + '\t'.repeat(100_000) + '```', source)
  ).toEqual(spec)
  expect(() =>
    parseReplayCase(JSON.stringify(spec) + '\t'.repeat(100_000) + 'invalid', source)
  ).toThrow(SyntaxError)
  for (const [ids, message] of [
    [['missing'], 'Scene 1, reference 1: unknown replay reference'],
    [['m2', 'm1'], 'Scene 1, reference 2: out-of-order replay reference'],
    [['m1', 'm1'], 'Scene 1, reference 2: duplicate replay reference']
  ] as const)
    expect(() =>
      parseReplayCase(
        JSON.stringify({ ...spec, scenes: [{ ...spec.scenes[0], evidenceIds: ids }] }),
        source
      )
    ).toThrow(message)
  expect(() => parseReplayCase(JSON.stringify({ ...spec, script: 'alert(1)' }), source)).toThrow()
  expect(() => parseReplayCase(JSON.stringify(spec), { ...source, replay: undefined })).toThrow()
})
it('provides ordered source positions and identifies the repeated reference when requesting correction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-authoring-'))
  roots.push(directory)
  const duplicate = {
    ...spec,
    scenes: [
      { id: 's1', evidenceIds: ['m1'], narration: 'The user asked about rainfall.' },
      { id: 's2', evidenceIds: ['m1'], narration: 'The user asked about rainfall.' }
    ]
  }
  const infer = vi
    .fn<Parameters<typeof createResearchFilmAuthor>[0]>()
    .mockResolvedValueOnce(JSON.stringify(duplicate))
    .mockResolvedValueOnce(JSON.stringify(spec))
  const result = await authorResearchFilmSource({
    source,
    directory,
    author: createResearchFilmAuthor(infer),
    signal: new AbortController().signal
  })
  expect(infer).toHaveBeenCalledTimes(2)
  expect(infer.mock.calls[0][2]).toMatchObject({
    source: {
      replay: {
        events: [
          { id: 'm1', position: 1 },
          { id: 'm2', position: 2 }
        ]
      }
    }
  })
  expect(infer.mock.calls[1][2]).toMatchObject({
    correction: {
      draft: JSON.stringify(duplicate),
      error: expect.stringContaining('Scene 2, reference 1: duplicate replay reference')
    }
  })
  expect(JSON.parse(await readFile(result.specPath, 'utf8'))).toEqual(spec)
  expect(source.replay?.events[0]).not.toHaveProperty('position')
})
it('builds an offline seekable player with continuous speech, source identity and safe text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-player-'))
  roots.push(root)
  await mkdir(join(root, 'voice'))
  const imageName = 'a'.repeat(64) + '.png'
  const unselectedImage = Buffer.from('unselected source image')
  const fullSource = structuredClone(source)
  fullSource.replay!.events.push({
    id: 'unselected',
    messageId: 'm3',
    kind: 'result',
    title: 'Figure',
    text: 'Recorded image',
    image: imageName
  })
  await mkdir(join(root, 'files'))
  await writeFile(join(root, 'files', imageName), unselectedImage)
  await writeFile(join(root, 'session.json'), JSON.stringify(fullSource))
  await writeFile(join(root, 'video.json'), JSON.stringify(spec))
  const words = narration.split(/\s+/)
  await writeFile(
    join(root, 'voice/timings.json'),
    JSON.stringify({ say: { s1_0: narration }, lines: { s1_0: words.length } })
  )
  await writeFile(
    join(root, 'voice/word-times.json'),
    JSON.stringify({ s1_0: words.map((_, i) => [i, i + 0.8]) })
  )
  await writeFile(join(root, 'voice/s1_0.wav'), 'fixture audio')
  await writeFile(join(root, 'mix.wav'), 'fixture audio')
  const frozen = await freezeReplaySource(
    join(root, 'video.json'),
    join(root, 'frozen'),
    new AbortController().signal
  )
  const result = await buildReplayPlayer({
    specPath: frozen,
    voiceDirectory: join(root, 'voice'),
    mixPath: join(root, 'mix.wav'),
    engineDirectory: researchFilmResources().stageDirectory,
    outputDirectory: join(root, 'output')
  })
  const html = await readFile(result.playerPath, 'utf8')
  expect(html).toContain("connect-src 'none'")
  const archive = unzipSync(await readFile(result.sourcePath))
  const timeline = JSON.parse(Buffer.from(archive['timeline.json']).toString())
  expect(timeline.pictures[0].end).toBe(timeline.pictures[1].start)
  expect(Buffer.from(archive['session.json']).toString()).toBe(JSON.stringify(fullSource))
  expect(Buffer.from(archive['files/' + imageName])).toEqual(unselectedImage)
  expect(html).not.toContain(unselectedImage.toString('base64'))
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://film.invalid/?render',
    beforeParse(window) {
      Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() } })
      Object.defineProperty(window.Image.prototype, 'src', {
        set() {
          queueMicrotask(() => this.onload?.())
        }
      })
    }
  })
  try {
    const window = dom.window as unknown as Window & {
      __ready: Promise<unknown>
      __seek(time: number): { scene: string; kind: string }
      __replayState(): { sourceId: string; kind: string }
      compromised?: boolean
    }
    await window.__ready
    expect(window.document.querySelector('.dv-omissions')?.textContent).toContain(
      'historical execution'
    )
    // The stage is absolutely positioned. Preview clipping must not hide export's zero-height root.
    expect(window.getComputedStyle(window.document.getElementById('root')!).overflow).not.toBe(
      'hidden'
    )
    window.__seek(result.duration - 0.1)
    expect(window.__replayState()).toMatchObject({ sourceId: 'm2', kind: 'conversation' })
    expect(window.document.querySelector('.dv-application-event > div')?.textContent).toBe(
      source.replay!.events[1].text
    )
    expect(window.compromised).toBeUndefined()
    window.__seek(0)
    expect(window.document.querySelector('.dv-operation-opening')).not.toBeNull()
    expect(window.document.querySelector('.dv-application-event')).toBeNull()
    window.__seek(timeline.scenes[1].start + 1)
    expect(window.__replayState()).toMatchObject({ sourceId: 'm1', kind: 'prompt' })
  } finally {
    dom.window.close()
  }
  const notifyParent = vi.fn()
  const preview = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://film.invalid/',
    beforeParse(window) {
      Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() } })
      Object.defineProperty(window.Image.prototype, 'src', {
        set() {
          queueMicrotask(() => this.onload?.())
        }
      })
      window.postMessage = notifyParent
    }
  })
  try {
    await (preview.window as unknown as { __ready: Promise<unknown> }).__ready
    expect(notifyParent).toHaveBeenCalledWith(
      { type: 'open-science-research-video-ready', duration: result.duration },
      '*'
    )
  } finally {
    preview.window.close()
  }
  source.replay!.events[0].image = '../private.png'
  await writeFile(join(root, 'session.json'), JSON.stringify(source))
  try {
    await expect(
      freezeReplaySource(join(root, 'video.json'), join(root, 'bad'), new AbortController().signal)
    ).rejects.toThrow('image identity')
  } finally {
    delete source.replay!.events[0].image
  }
})
