import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { APP } from '../../shared/app-config'
import { verifyWindowsRuntimeComponent } from './windows-runtime-components'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

it.each(['success', 'corruption', 'cancellation'] as const)(
  'overlaps slow runtime reads and drains them before returning on %s',
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-verification-'))
    const digest = createHash('sha256').update('fixture').digest('hex')
    const files = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        index === 0 ? 'node.exe' : `module-${index}/file.js`,
        digest
      ])
    )
    const controller = new AbortController()
    const waiting: PassThrough[] = []
    let reads = 0
    let settled = false
    let released = false
    vi.mocked(createReadStream).mockImplementation(() => {
      reads++
      const stream = new PassThrough()
      if (released) stream.end('fixture')
      else waiting.push(stream)
      return stream as unknown as ReturnType<typeof createReadStream>
    })
    let operation: Promise<unknown> | undefined
    try {
      for (const path of Object.keys(files)) {
        if (path.includes('/')) await mkdir(join(root, path.split('/')[0]!))
        await writeFile(join(root, path), 'fixture')
      }
      operation = verifyWindowsRuntimeComponent(
        {
          component: 'node',
          version: '1.2.3',
          architecture: 'x64',
          source: 'patched',
          archive: {
            url: `${APP.cdnBaseUrl}/notebook-runtime/fixture.tar.zst`,
            sha256: digest,
            size: 7
          },
          files
        },
        root,
        controller.signal
      ).then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      // A serial verifier never reaches this point until the first slow read is released.
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(1))
      expect(reads).toBeLessThanOrEqual(8)
      expect(settled).toBe(false)
      if (outcome === 'cancellation') controller.abort(new Error('cancel verification'))
      waiting.shift()!.end(outcome === 'corruption' ? 'tampered' : 'fixture')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      released = true
      waiting.splice(0).forEach((stream) => stream.end('fixture'))
      const result = await operation
      if (outcome === 'success') {
        expect(result).toBeUndefined()
        expect(reads).toBe(Object.keys(files).length)
      } else {
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toContain(
          outcome === 'corruption' ? 'integrity check failed' : 'cancel verification'
        )
        expect(reads).toBeLessThan(Object.keys(files).length)
      }
    } finally {
      released = true
      waiting.splice(0).forEach((stream) => stream.end('fixture'))
      await operation
      vi.mocked(createReadStream).mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
)
