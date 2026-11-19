import type { FilmVisualResult } from '@aipoch/research-film/contracts'
import { buildResearchVideoPlayer, researchFilmResources } from '@aipoch/research-film'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import {
  assertHeadlessResearchFilmReady,
  checkHeadlessResearchFilmHtml,
  locateResearchFilmBrowser
} from './headless-review'
import { FilmDraftVisualError } from './player-review'

const browser = process.env.OPEN_SCIENCE_TEST_FILM_BROWSER
const browserVariable = 'OPEN_SCIENCE_RESEARCH_FILM_BROWSER'
const browserTest = browser ? it : it.skip
const marker = '<meta name="open-science-research-video" content="1">'

afterEach(() => vi.unstubAllEnvs())

it('preserves an explicit browser choice and rejects a relative or missing executable', async () => {
  vi.stubEnv(browserVariable, process.execPath)
  await expect(locateResearchFilmBrowser()).resolves.toBe(process.execPath)
  vi.stubEnv(browserVariable, 'chromium')
  await expect(locateResearchFilmBrowser()).rejects.toThrow(browserVariable)
  vi.stubEnv(browserVariable, join(tmpdir(), 'unavailable-open-science-browser'))
  await expect(locateResearchFilmBrowser()).rejects.toThrow(browserVariable)
})

async function checkPlayer(script: string, issueIn?: '9x16' | '16x9'): Promise<FilmVisualResult> {
  vi.stubEnv(browserVariable, browser)
  const directory = await mkdtemp(join(tmpdir(), 'open-science-film-review-'))
  const htmlPath = join(directory, 'player.html')
  try {
    await writeFile(
      htmlPath,
      `${marker}
      <body style="background:blue"><script>
      const aspect = new URL(location.href).searchParams.get('ar');
      const portrait = aspect === '9x16';
      window.__ready = { W: portrait ? 1080 : 1920, H: portrait ? 1920 : 1080, duration: 2 };
      window.__seek = (time) => { document.body.style.backgroundColor = time > 0 ? 'green' : 'blue'; };
      window.__checkFilm = async function () {
        ${script}
        return {
          issues: aspect === ${JSON.stringify(issueIn ?? '')} ? [{ scene: 'slide', message: 'Layout overflow' }] : [],
          frames: [{ scene: 'slide', time: 0.5 }]
        };
      };
      </script></body>`
    )
    return await checkHeadlessResearchFilmHtml(
      { htmlPath, includeFrames: true },
      new AbortController().signal
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

browserTest(
  'renders the two orientations offline and captures landscape model-review frames',
  async () => {
    const result = await checkPlayer(`
    if (window.RTCPeerConnection) throw new Error('Unexpected WebRTC access');
    if (navigator.onLine) throw new Error('Unexpected network access');
    if (innerWidth !== window.__ready.W || innerHeight !== window.__ready.H)
      throw new Error('Unexpected viewport');
  `)
    expect(result.issues).toEqual([])
    expect(result.frames).toHaveLength(1)
    const [frame] = result.frames
    expect(frame).toMatchObject({ scene: 'slide', time: 0.5 })
    const image = sharp(Buffer.from(frame!.jpeg, 'base64'))
    await expect(image.metadata()).resolves.toMatchObject({
      format: 'jpeg',
      width: 960,
      height: 540
    })
    const pixel = await image.extract({ left: 480, top: 270, width: 1, height: 1 }).raw().toBuffer()
    expect(pixel[1]).toBeGreaterThan(105)
    expect(pixel[2]).toBeLessThan(15)
  },
  25_000
)

browserTest.each(['9x16', '16x9'] as const)(
  'reports a %s-specific issue without a frame',
  async (aspect) => {
    await expect(checkPlayer('', aspect)).resolves.toEqual({
      issues: [{ scene: 'slide', message: `${aspect}: Layout overflow` }],
      frames: []
    })
  },
  25_000
)

browserTest(
  'reports a safe draft error when player review code fails',
  async () => {
    const failed = checkPlayer("throw new Error('Untrusted draft text')")
    await expect(failed).rejects.toBeInstanceOf(FilmDraftVisualError)
    await expect(failed).rejects.toThrow('The player did not produce a valid layout review.')
  },
  25_000
)

browserTest(
  'reviews an actual generated, self-contained Film player without the desktop',
  async () => {
    vi.stubEnv(browserVariable, browser)
    await assertHeadlessResearchFilmReady(new AbortController().signal)
    const directory = await mkdtemp(join(tmpdir(), 'open-science-generated-film-'))
    const voice = join(directory, 'voice')
    try {
      await mkdir(voice)
      const specPath = join(directory, 'video.json')
      const wav = Buffer.alloc(44 + 32_000)
      wav.write('RIFF', 0)
      wav.writeUInt32LE(wav.length - 8, 4)
      wav.write('WAVEfmt ', 8)
      wav.writeUInt32LE(16, 16)
      wav.writeUInt16LE(1, 20)
      wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(16_000, 24)
      wav.writeUInt32LE(32_000, 28)
      wav.writeUInt16LE(2, 32)
      wav.writeUInt16LE(16, 34)
      wav.write('data', 36)
      wav.writeUInt32LE(32_000, 40)
      await Promise.all([
        writeFile(
          specPath,
          JSON.stringify({
            title: 'Evidence',
            session: 'session.json',
            scenes: [
              {
                id: 'outro',
                role: 'outro',
                msg: 0,
                lines: [{ caption: 'Evidence.' }],
                panels: [{ type: 'end_card' }]
              }
            ]
          })
        ),
        writeFile(
          join(directory, 'session.json'),
          JSON.stringify({ messages: [{ md: 'Evidence.' }] })
        ),
        writeFile(
          join(voice, 'timings.json'),
          JSON.stringify({ say: { outro_0: 'Evidence.' }, lines: { outro_0: 1 } })
        ),
        writeFile(join(voice, 'word-times.json'), JSON.stringify({ outro_0: [[0, 1]] })),
        writeFile(join(voice, 'outro_0.wav'), wav),
        writeFile(join(directory, 'mix.wav'), wav)
      ])
      const generated = await buildResearchVideoPlayer({
        specPath,
        voiceDirectory: voice,
        engineDirectory: researchFilmResources().stageDirectory,
        outputDirectory: join(directory, 'output')
      })
      const reviewed = await checkHeadlessResearchFilmHtml(
        { htmlPath: generated.playerPath, includeFrames: true },
        new AbortController().signal
      )
      expect(reviewed.issues).toEqual([])
      expect(reviewed.frames).toHaveLength(1)
      expect(reviewed.frames[0]?.scene).toBe('outro')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  25_000
)
