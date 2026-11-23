import { assertResearchVideoPlayerSize } from './source.js'
import { researchFilmResources } from './resources.js'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildResearchVideoPlayer, readVideoSourceFile } from './build-player.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('research video source boundaries', () => {
  it('accepts the player byte limit and reports how to reduce an oversized film', () => {
    const limit = 200 * 1024 * 1024
    expect(() => assertResearchVideoPlayerSize(limit)).not.toThrow()
    expect(() => assertResearchVideoPlayerSize(limit + 1)).toThrow(
      'Shorten it or use smaller media.'
    )
  })

  it('preserves engine and source bytes, and rejects source names that overwrite generated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-video-'))
    roots.push(root)
    await mkdir(join(root, 'voice'))
    const spec = {
      title: 'Evidence',
      session: 'session.json',
      scenes: [
        {
          id: 's',
          msg: 0,
          lines: [{ caption: 'Evidence.' }],
          panels: [{ type: 'title', text: 'Evidence' }]
        }
      ]
    }
    await writeFile(join(root, 'video.json'), JSON.stringify(spec))
    await writeFile(join(root, 'session.json'), JSON.stringify({ messages: [{ md: 'Evidence.' }] }))
    await writeFile(
      join(root, 'voice', 'timings.json'),
      JSON.stringify({ say: { s_0: 'Evidence.' }, lines: { s_0: 1 } })
    )
    await writeFile(join(root, 'voice', 'word-times.json'), JSON.stringify({ s_0: [[0, 1]] }))
    await writeFile(join(root, 'voice', 's_0.wav'), Buffer.from('test audio'))
    await writeFile(join(root, 'mix.wav'), Buffer.from('test audio'))
    const drawing = JSON.stringify({ parts: [{ type: 'circle', r: 10 }] })
    await mkdir(join(root, 'subjects'))
    await writeFile(join(root, 'subjects', 'landmark.json'), drawing)
    const engineDirectory = join(researchFilmResources().stageDirectory, '')
    const options = {
      specPath: join(root, 'video.json'),
      voiceDirectory: join(root, 'voice'),
      engineDirectory,
      outputDirectory: join(root, 'output')
    }
    const result = await buildResearchVideoPlayer(options)
    const archive = unzipSync(await readFile(result.sourcePath))
    expect(Buffer.from(archive['engine/js/stage.js'])).toEqual(
      await readFile(join(engineDirectory, 'js/stage.js'))
    )
    expect(Buffer.from(archive['subjects/landmark.json']).toString()).toBe(drawing)
    expect(await readFile(result.playerPath, 'utf8')).toContain(
      `"subjects":{"landmark":${drawing}}`
    )
    expect(Buffer.from(archive['video.json'])).toEqual(await readFile(options.specPath))
    expect(JSON.parse(Buffer.from(archive['manifest.json']).toString()).files).toContainEqual({
      path: 'engine/js/stage.js',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    const appOptions = { ...options, outputDirectory: join(root, 'app-output') }
    await mkdir(join(root, 'libs'))
    const appBytes = Buffer.from('window.APP = { position(t) { return t * 2 } };')
    await writeFile(join(root, 'libs', 'app.js'), appBytes)
    await writeFile(options.specPath, JSON.stringify({ ...spec, libs: ['libs/app.js'] }))
    await expect(buildResearchVideoPlayer(appOptions)).rejects.toThrow('approval is required')
    await expect(
      buildResearchVideoPlayer({ ...appOptions, provenance: { sessionAppSha256: 'a'.repeat(64) } })
    ).rejects.toThrow('approved session app changed')
    const provenance = {
      sessionAppSha256: createHash('sha256').update(appBytes).digest('hex'),
      scriptScore: 0
    }
    const live = await buildResearchVideoPlayer({ ...appOptions, provenance })
    const liveSources = unzipSync(await readFile(live.sourcePath))
    expect(Buffer.from(liveSources['libs/app.js'])).toEqual(appBytes)
    expect(JSON.parse(Buffer.from(liveSources['manifest.json']).toString()).provenance).toEqual(
      provenance
    )
    expect((await readFile(live.playerPath, 'utf8')).slice(0, 96)).toContain(
      '<!--open-science-film-card:0:live-->'
    )
    expect(await readFile(live.playerPath, 'utf8')).toContain('"scriptScore":0')
    await writeFile(options.specPath, JSON.stringify({ ...spec, session: 'engine/js/stage.js' }))
    await expect(buildResearchVideoPlayer(options)).rejects.toThrow(
      'conflicts with generated bundle files'
    )
  })
  it('reads contained files and rejects portable path escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-video-'))
    roots.push(root)
    await writeFile(join(root, 'data.json'), '{}')
    expect((await readVideoSourceFile(root, 'data.json')).toString()).toBe('{}')
    for (const name of [
      '../data.json',
      '/data.json',
      'C:/data.json',
      'sub\\data.json',
      'a/../data.json',
      './data.json'
    ]) {
      await expect(readVideoSourceFile(root, name)).rejects.toThrow('Invalid source path')
    }
  })
  it('rejects a symlink to a sibling source directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-video-'))
    roots.push(root)
    await mkdir(join(root, 'input'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'data.json'), '{}')
    await symlink(
      join(root, 'outside'),
      join(root, 'input', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(readVideoSourceFile(join(root, 'input'), 'linked/data.json')).rejects.toThrow(
      'escapes bundle'
    )
  })
})
