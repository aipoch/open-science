import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { freezeResearchVideoSource } from './freeze-source.js'

it('freezes exactly referenced source bytes, preserving the originals and excluding unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-freeze-'))
  try {
    const spec = {
      title: 'Evidence',
      session: 'session.json',
      scenes: [
        {
          id: 's',
          msg: 0,
          lines: [{ caption: 'Exact evidence.' }],
          panels: [{ type: 'animation', script: 'animation.js' }]
        }
      ]
    }
    await writeFile(join(root, 'video.json'), JSON.stringify(spec))
    await writeFile(
      join(root, 'session.json'),
      JSON.stringify({ messages: [{ id: 'source-message', md: 'Exact evidence' }] })
    )
    await writeFile(join(root, 'animation.js'), 'k.ctx.fillRect(0,0,1,1)')
    await writeFile(join(root, 'unrelated.txt'), 'private')
    const result = await freezeResearchVideoSource(
      join(root, 'video.json'),
      join(root, 'frozen'),
      new AbortController().signal
    )
    await writeFile(join(root, 'animation.js'), 'changed')
    expect(await readFile(join(root, 'frozen', 'animation.js'), 'utf8')).toBe(
      'k.ctx.fillRect(0,0,1,1)'
    )
    expect((await readdir(join(root, 'frozen'))).sort()).toEqual([
      'animation.js',
      'session.json',
      'video.json'
    ])
    expect(JSON.parse(await readFile(result, 'utf8'))).toEqual(spec)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects unsupported voice settings before creating a source snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-freeze-'))
  try {
    await writeFile(
      join(root, 'video.json'),
      JSON.stringify({
        title: 'Evidence',
        session: 'session.json',
        voice: { speed: 2 },
        scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Evidence.' }], panels: [] }]
      })
    )
    await expect(
      freezeResearchVideoSource(
        join(root, 'video.json'),
        join(root, 'frozen'),
        new AbortController().signal
      )
    ).rejects.toThrow('speed 1 only')
    expect(await readdir(root)).toEqual(['video.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
