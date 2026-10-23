import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { link, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withFileIoPacing } from '../file-io-pacing'
import { createPackageContentVerifier } from './materialize'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const roots: string[] = []
const fixture = async (): Promise<{ source: string; alias: string; payload: Buffer }> => {
  const root = await mkdtemp(join(tmpdir(), 'package-verify-'))
  roots.push(root)
  const source = join(root, 'source')
  const alias = join(root, 'alias')
  const payload = Buffer.alloc(128 * 1024, 42)
  await writeFile(source, payload)
  await link(source, alias)
  return { source, alias, payload }
}
afterEach(async () => {
  vi.mocked(fs.lstat).mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  'reads unchanged aliases once per invocation with large inode=%s while validating each caller budget',
  async (largeInode) => {
    const { source, alias, payload } = await fixture()
    if (largeInode) {
      const { lstat } = await vi.importActual<typeof fs>('node:fs/promises')
      vi.mocked(fs.lstat).mockImplementation(async (...args) => {
        const stat = await lstat(...args)
        // NTFS file IDs can exceed the integer precision of a JavaScript number.
        stat.ino = (typeof stat.ino === 'bigint' ? 2n ** 60n : 2 ** 60) as typeof stat.ino
        return stat
      })
    }
    let bytes = 0
    await withFileIoPacing(
      async (size) => {
        bytes += size
      },
      async () => {
        const verify = createPackageContentVerifier()
        const digest = await verify(source, payload.length)
        expect(digest).toEqual({
          sizeBytes: payload.length,
          checksum: createHash('sha256').update(payload).digest('hex')
        })
        expect(await verify(alias, payload.length)).toEqual(digest)
        expect(await verify(source, payload.length)).toEqual(digest)
        expect(bytes).toBe(payload.length)
        await expect(verify(alias, payload.length - 1)).rejects.toThrow()
        const controller = new AbortController()
        controller.abort(new Error('cancelled'))
        await expect(verify(alias, payload.length, controller.signal)).rejects.toThrow('cancelled')
        await createPackageContentVerifier()(alias, payload.length)
        expect(bytes).toBe(payload.length * 2)
      }
    )
  }
)

it('does not trust a replaced source or separately stored legacy object', async () => {
  const { source, payload } = await fixture()
  let bytes = 0
  await withFileIoPacing(
    async (size) => {
      bytes += size
    },
    async () => {
      const verify = createPackageContentVerifier()
      const original = await verify(source, payload.length)
      const replacement = `${source}.replacement`
      await writeFile(replacement, payload)
      expect(await verify(replacement, payload.length)).toEqual(original)
      expect(bytes).toBe(payload.length * 2)
      await writeFile(replacement, Buffer.alloc(payload.length, 1))
      await rename(replacement, source)
      expect((await verify(source, payload.length)).checksum).not.toBe(original.checksum)
      expect(bytes).toBe(payload.length * 3)
    }
  )
})

it('rehashes a same-size in-place edit and rejects edits made while hashing', async () => {
  const { source, alias, payload } = await fixture()
  const verify = createPackageContentVerifier()
  const original = await verify(source, payload.length)
  await writeFile(alias, Buffer.alloc(payload.length, 1))
  expect((await verify(source, payload.length)).checksum).not.toBe(original.checksum)
  let changed = false
  await expect(
    withFileIoPacing(
      async () => {
        if (!changed) {
          changed = true
          await writeFile(alias, 'changed during read')
        }
      },
      () => createPackageContentVerifier()(source, payload.length)
    )
  ).rejects.toThrow('changed during validation')
})

// Temporary assessment only: a fresh public verifier per call measures re-reading without
// changing production code. Fixture writes are excluded; both modes use warm filesystem caches.
const performanceCases = [
  {
    name: 'independent-small',
    size: 64 * 1024,
    unique: 256,
    copies: 1,
    kind: 'link',
    rate: 1024 ** 3
  },
  {
    name: 'independent-medium',
    size: 4 * 1024 ** 2,
    unique: 32,
    copies: 1,
    kind: 'link',
    rate: 1024 ** 3
  },
  {
    name: 'mixed-four-aliases',
    size: 4 * 1024 ** 2,
    unique: 32,
    copies: 4,
    kind: 'link',
    rate: 1024 ** 3
  },
  {
    name: 'same-path-32-references',
    size: 32 * 1024 ** 2,
    unique: 1,
    copies: 32,
    kind: 'path',
    rate: 1024 ** 3
  },
  {
    name: 'hardlinks-32-references',
    size: 32 * 1024 ** 2,
    unique: 1,
    copies: 32,
    kind: 'link',
    rate: 1024 ** 3
  },
  {
    name: 'large-hardlinks-eight-references',
    size: 128 * 1024 ** 2,
    unique: 1,
    copies: 8,
    kind: 'link',
    rate: 1024 ** 3
  },
  {
    name: 'hardlinks-user-limit-64MiB',
    size: 4 * 1024 ** 2,
    unique: 1,
    copies: 64,
    kind: 'link',
    rate: 64 * 1024 ** 2
  }
]

it.each(performanceCases)('verifier cache performance assessment: $name', async (scenario) => {
  const { withPackageTransfer } = await import('./transfer')
  const { randomFillSync } = await import('node:crypto')
  const { cpus, release, totalmem } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'verifier-benchmark-'))
  roots.push(directory)
  const payload = randomFillSync(Buffer.allocUnsafe(scenario.size))
  const checksum = createHash('sha256').update(payload).digest('hex')
  const paths: string[] = []
  for (let i = 0; i < scenario.unique; i++) {
    const source = join(directory, `source-${i}`)
    await writeFile(source, payload)
    paths.push(source)
    for (let alias = 1; alias < scenario.copies; alias++) {
      if (scenario.kind === 'path') paths.push(source)
      else {
        const target = join(directory, `alias-${i}-${alias}`)
        await link(source, target)
        paths.push(target)
      }
    }
  }
  // Finish metadata updates and warm every unique object before either measured mode.
  const warmup = createPackageContentVerifier()
  for (const path of paths) await warmup(path, scenario.size)
  const samples: Array<{
    mode: string
    round: number
    wallMs: number
    cpuMs: number
    readBytes: number
  }> = []
  for (let round = 0; round < 3; round++) {
    const modes = round % 2 === 0 ? ['cached', 'reread'] : ['reread', 'cached']
    for (const mode of modes) {
      const shared = createPackageContentVerifier()
      let readBytes = 0
      const cpuBefore = process.cpuUsage()
      const start = performance.now()
      await withPackageTransfer(
        (transfer) =>
          withFileIoPacing(
            async (bytes, signal) => {
              readBytes += bytes
              await transfer.pace(bytes, signal)
            },
            async () => {
              for (const path of paths) {
                const verify = mode === 'cached' ? shared : createPackageContentVerifier()
                const digest = await verify(path, scenario.size, transfer.signal)
                if (digest.sizeBytes !== scenario.size || digest.checksum !== checksum)
                  throw new Error('Benchmark content verification failed')
              }
            }
          ),
        () => scenario.rate
      )
      const wallMs = performance.now() - start
      const cpu = process.cpuUsage(cpuBefore)
      expect(readBytes).toBe(
        scenario.size * scenario.unique * (mode === 'cached' ? 1 : scenario.copies)
      )
      samples.push({ mode, round, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, readBytes })
    }
  }
  process.stdout.write(
    `[BENCH-verifier] ${JSON.stringify({
      scenario,
      platform: process.platform,
      node: process.version,
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      samples
    })}\n`
  )
})
