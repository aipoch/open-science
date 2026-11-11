import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportResearchVideoMp4 } from './export-mp4.js'

describe('research video export', () => {
  it('rejects invalid media before launching a renderer or encoder', async () => {
    await expect(
      exportResearchVideoMp4({
        renderer: { capture: async () => new Uint8Array() },
        audioPath: 'unused',
        outputPath: 'unused',
        encoderPath: 'unused',
        probePath: 'unused',
        width: 1279,
        height: 720,
        duration: 3,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('dimensions')
  })
  it('removes partial output when the encoder cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-export-'))
    try {
      await expect(
        exportResearchVideoMp4({
          renderer: {
            capture: async () => {
              await new Promise((r) => setTimeout(r, 10))
              return new Uint8Array()
            }
          },
          audioPath: 'unused',
          outputPath: join(root, 'output.mp4'),
          encoderPath: join(root, 'missing-encoder'),
          probePath: 'unused',
          width: 1280,
          height: 720,
          duration: 0.1,
          signal: new AbortController().signal
        })
      ).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
