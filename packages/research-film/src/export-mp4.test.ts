import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

  it.skipIf(process.platform === 'win32')(
    'cancels a backpressured encode and joins the encoder before returning',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'video-export-backpressure-'))
      const controller = new AbortController()
      const encoderPath = join(root, 'encoder')
      const pidPath = join(root, 'encoder.pid')
      const fallbackPath = join(root, 'encoder-fallback')
      const captured = Promise.withResolvers<void>()
      const outputPath = join(root, 'output.mp4')
      try {
        await writeFile(
          encoderPath,
          `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.on('SIGTERM', () => {});\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(fallbackPath)}, 'timed out'), 2000);`,
          { mode: 0o700 }
        )
        const result = exportResearchVideoMp4({
          renderer: {
            capture: async () => {
              captured.resolve()
              return Buffer.alloc(8 * 1024 * 1024)
            }
          },
          audioPath: 'unused',
          outputPath,
          encoderPath,
          probePath: 'unused',
          width: 2,
          height: 2,
          duration: 1 / 30,
          signal: controller.signal
        }).catch((error: unknown) => error)
        const pid = await vi.waitFor(async () => Number(await readFile(pidPath, 'utf8')))
        await captured.promise
        controller.abort()
        expect(await result).toMatchObject({ code: 'ABORT_ERR' })
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(await readdir(root)).not.toContain('encoder-fallback')
        expect(await readdir(root)).not.toContain('output.mp4')
      } finally {
        controller.abort()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'joins the verifier on cancellation even if it ignores SIGTERM',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'video-export-probe-'))
      const controller = new AbortController()
      const encoderPath = join(root, 'encoder')
      const probePath = join(root, 'probe')
      const pidPath = join(root, 'probe.pid')
      const outputPath = join(root, 'output.mp4')
      try {
        await writeFile(
          encoderPath,
          `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => require('node:fs').writeFileSync(process.argv.at(-1), 'video'));`,
          { mode: 0o700 }
        )
        await writeFile(
          probePath,
          `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => process.exit(0), 5000);`,
          { mode: 0o700 }
        )
        const result = exportResearchVideoMp4({
          renderer: { capture: async () => Buffer.from('frame') },
          audioPath: 'unused',
          outputPath,
          encoderPath,
          probePath,
          width: 2,
          height: 2,
          duration: 1 / 30,
          signal: controller.signal
        }).catch((error: unknown) => error)
        const pid = await vi.waitFor(async () => {
          const pid = Number(await readFile(pidPath, 'utf8'))
          expect(pid).toBeGreaterThan(0)
          return pid
        })
        controller.abort()
        expect(await result).toMatchObject({ code: 'ABORT_ERR' })
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(await readdir(root)).not.toContain('output.mp4')
      } finally {
        controller.abort()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
