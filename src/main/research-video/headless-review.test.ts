import type { FilmVisualIssue } from '@aipoch/research-film/contracts'
import { buildResearchVideoPlayer, researchFilmResources } from '@aipoch/research-film'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function checkPlayer(script: string): Promise<FilmVisualIssue[]> {
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
      window.__checkFilm = async function () {
        const issues = [];
        const frames = [{ scene: 'slide', time: 0.5 }];
        ${script}
        return { issues, frames };
      };
      </script></body>`
    )
    return await checkHeadlessResearchFilmHtml(htmlPath, new AbortController().signal)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

browserTest(
  'renders both orientations offline and retains ranked findings from each',
  async () => {
    const result = await checkPlayer(`
    if (window.RTCPeerConnection) throw new Error('Unexpected WebRTC access');
    if (navigator.onLine) throw new Error('Unexpected network access');
    if (innerWidth !== window.__ready.W || innerHeight !== window.__ready.H)
      throw new Error('Unexpected viewport');
    issues.push(portrait
      ? { scene: 'slide', message: 'Layout overflow', textLayout: true }
      : { scene: 'slide', message: 'Blank animation', renderFailure: true });
  `)
    expect(result).toEqual([
      { scene: 'slide', message: '9x16: Layout overflow', textLayout: true },
      { scene: 'slide', message: '16x9: Blank animation', renderFailure: true }
    ])
  },
  25_000
)

browserTest(
  'rejects observations with a sample time outside the player duration',
  async () => {
    await expect(checkPlayer('frames[0].time = 5')).rejects.toMatchObject({
      scene: 'slide',
      message: 'Film review time lies outside the player duration.'
    } satisfies Partial<FilmDraftVisualError>)
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
        generated.playerPath,
        new AbortController().signal
      )
      expect(reviewed).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  25_000
)
