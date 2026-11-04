import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { RESEARCH_VIDEO_GUIDE } from './tool-contract.js'
import { authorResearchFilmSource, generateResearchFilm } from './authoring.js'

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
    }
  ]
}
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

it('authors the minimal tool-guide screenplay with its documented animation files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'film-guide-'))
  try {
    const screenplay = RESEARCH_VIDEO_GUIDE.split('\n').find((line) =>
      line.startsWith('{"version":1')
    )!
    const helper = RESEARCH_VIDEO_GUIDE.split('anims/subject.js: ')[1].split('\n')[0]
    const scene = RESEARCH_VIDEO_GUIDE.split('anims/hook.js: ')[1].split('\n')[0]
    const result = await authorResearchFilmSource({
      source,
      directory,
      signal: new AbortController().signal,
      author: {
        writeScreenplay: async () => screenplay,
        writeAnimation: async (_source, input) => (input.shared ? helper : scene)
      }
    })
    expect(JSON.parse(await readFile(result.specPath, 'utf8')).scenes[0].panels).toHaveLength(2)
    expect(await readFile(join(directory, 'anims/hook.js'), 'utf8')).toBe(scene)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
