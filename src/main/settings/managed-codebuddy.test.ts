import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CODEBUDDY_VERSION,
  installManagedCodeBuddy,
  isManagedCodeBuddyPath,
  managedCodeBuddyBinary,
  managedCodeBuddyRoot,
  uninstallManagedCodeBuddy
} from './managed-codebuddy'

const tarEntry = (name: string, content: Buffer, type = '0'): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write(type, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded])
}

const buildTgz = (entries: Array<{ name: string; content: string }>): Buffer =>
  gzipSync(
    Buffer.concat([
      ...entries.map(({ name, content }) => tarEntry(name, Buffer.from(content))),
      Buffer.alloc(1024)
    ])
  )

const integrity = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

const installFixture = async (
  dataRoot: string,
  tgz: Buffer,
  verifiedVersion: string | undefined = CODEBUDDY_VERSION,
  renamePath?: typeof rename
): Promise<{
  onEvent: ReturnType<typeof vi.fn>
  outcome: Awaited<ReturnType<typeof installManagedCodeBuddy>>
}> => {
  const onEvent = vi.fn()
  const outcome = await installManagedCodeBuddy({
    installId: 'codebuddy-install',
    onEvent,
    dataRoot,
    registries: ['https://registry.example.test'],
    platform: 'darwin',
    execPath: '/Applications/Open Science.app/Contents/MacOS/Open Science',
    fetchJson: async (url) => {
      expect(url).toBe('https://registry.example.test/@tencent-ai%2Fcodebuddy-code')
      return {
        versions: {
          [CODEBUDDY_VERSION]: {
            dist: {
              tarball: 'https://registry.example.test/codebuddy.tgz',
              integrity: integrity(tgz)
            }
          }
        }
      }
    },
    fetchTarball: async () => ({ stream: Readable.from(tgz), totalBytes: tgz.length }),
    verify: async () => verifiedVersion,
    ...(renamePath ? { renamePath } : {})
  })
  return { onEvent, outcome }
}

describe('managed CodeBuddy runtime', () => {
  let dataRoot: string | undefined

  afterEach(async () => {
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
    dataRoot = undefined
  })

  it('installs the pinned package into the app-owned runtime and writes a login-free shim', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const tgz = buildTgz([
      { name: 'package/package.json', content: '{"name":"@tencent-ai/codebuddy-code"}' },
      { name: 'package/bin/codebuddy', content: 'console.log("codebuddy")\n' }
    ])

    const { onEvent, outcome } = await installFixture(dataRoot, tgz)
    const binary = managedCodeBuddyBinary(dataRoot, 'darwin')

    expect(outcome).toEqual({
      result: { installId: 'codebuddy-install', ok: true },
      resolvedPath: binary,
      version: CODEBUDDY_VERSION
    })
    expect(
      await readFile(join(managedCodeBuddyRoot(dataRoot), 'package/bin/codebuddy'), 'utf8')
    ).toContain('codebuddy')
    expect(await readFile(binary, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(await readFile(binary, 'utf8')).toContain(
      "'/Applications/Open Science.app/Contents/MacOS/Open Science'"
    )
    expect(isManagedCodeBuddyPath(binary, dataRoot)).toBe(true)
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'progress',
      installId: 'codebuddy-install',
      phase: 'extracting'
    })
  })

  it('replaces an earlier package and uninstalls the owned tree idempotently', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const first = buildTgz([
      { name: 'package/bin/codebuddy', content: 'first' },
      { name: 'package/obsolete.txt', content: 'obsolete' }
    ])
    const second = buildTgz([{ name: 'package/bin/codebuddy', content: 'second' }])

    await expect(installFixture(dataRoot, first)).resolves.toMatchObject({
      outcome: { result: { ok: true } }
    })
    await expect(installFixture(dataRoot, second)).resolves.toMatchObject({
      outcome: { result: { ok: true } }
    })
    await expect(
      access(join(managedCodeBuddyRoot(dataRoot), 'package/obsolete.txt'))
    ).rejects.toThrow()
    expect(
      await readFile(join(managedCodeBuddyRoot(dataRoot), 'package/bin/codebuddy'), 'utf8')
    ).toBe('second')

    await uninstallManagedCodeBuddy(dataRoot)
    await uninstallManagedCodeBuddy(dataRoot)
    await expect(access(managedCodeBuddyRoot(dataRoot))).rejects.toThrow()
  })

  it('ignores archive entries that normalize outside package/', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const tgz = buildTgz([
      { name: 'package/bin/codebuddy', content: 'safe' },
      { name: 'package/../../outside.txt', content: 'unsafe' }
    ])

    await expect(installFixture(dataRoot, tgz)).resolves.toMatchObject({
      outcome: { result: { ok: true } }
    })
    await expect(access(join(dataRoot, 'outside.txt'))).rejects.toThrow()
  })

  it('rejects a package that does not report the pinned version', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const tgz = buildTgz([{ name: 'package/bin/codebuddy', content: 'wrong-version' }])

    const { outcome } = await installFixture(dataRoot, tgz, '2.139.0')

    expect(outcome.result).toEqual({
      installId: 'codebuddy-install',
      ok: false,
      error: `The installed CodeBuddy runtime reported unsupported version 2.139.0; expected ${CODEBUDDY_VERSION}.`
    })
    expect(outcome.resolvedPath).toBeUndefined()
  })

  it('preserves the working runtime when a replacement fails verification', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const working = buildTgz([{ name: 'package/bin/codebuddy', content: 'working' }])
    const invalid = buildTgz([{ name: 'package/bin/codebuddy', content: 'invalid' }])

    await expect(installFixture(dataRoot, working)).resolves.toMatchObject({
      outcome: { result: { ok: true } }
    })
    await expect(installFixture(dataRoot, invalid, '2.139.0')).resolves.toMatchObject({
      outcome: { result: { ok: false } }
    })

    expect(
      await readFile(join(managedCodeBuddyRoot(dataRoot), 'package/bin/codebuddy'), 'utf8')
    ).toBe('working')
    await expect(access(managedCodeBuddyBinary(dataRoot, 'darwin'))).resolves.toBeUndefined()
  })

  it('restores the working runtime when the staged swap fails', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const working = buildTgz([{ name: 'package/bin/codebuddy', content: 'working' }])
    const replacement = buildTgz([{ name: 'package/bin/codebuddy', content: 'replacement' }])
    const root = managedCodeBuddyRoot(dataRoot)

    await installFixture(dataRoot, working)
    const renamePath = vi.fn(async (...args: Parameters<typeof rename>) => {
      const [source, destination] = args
      if (String(source).includes('.staging-') && String(destination) === root) {
        throw new Error('swap failed')
      }
      await rename(source, destination)
    })
    const { outcome } = await installFixture(dataRoot, replacement, CODEBUDDY_VERSION, renamePath)

    expect(outcome.result).toMatchObject({ ok: false, error: 'swap failed' })
    expect(await readFile(join(root, 'package/bin/codebuddy'), 'utf8')).toBe('working')
    expect((await readdir(dataRoot)).filter((name) => name.includes('.backup-'))).toEqual([])
  })

  it('preserves recovery details and lets uninstall remove a failed restore backup', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'managed-codebuddy-'))
    const working = buildTgz([{ name: 'package/bin/codebuddy', content: 'working' }])
    const replacement = buildTgz([{ name: 'package/bin/codebuddy', content: 'replacement' }])
    const root = managedCodeBuddyRoot(dataRoot)

    await installFixture(dataRoot, working)
    const renamePath = vi.fn(async (...args: Parameters<typeof rename>) => {
      const [source, destination] = args
      if (String(source).includes('.staging-') && String(destination) === root) {
        throw new Error('swap failed')
      }
      if (String(source).includes('.backup-') && String(destination) === root) {
        throw new Error('restore failed')
      }
      await rename(source, destination)
    })
    const { outcome } = await installFixture(dataRoot, replacement, CODEBUDDY_VERSION, renamePath)
    const error = outcome.result.ok ? '' : outcome.result.error
    const backupName = (await readdir(dataRoot)).find((name) => name.includes('.backup-'))

    expect(error).toContain('CodeBuddy runtime swap failed: swap failed.')
    expect(error).toContain('because restore failed: restore failed.')
    expect(error).toContain(backupName)
    expect(backupName).toBeDefined()
    expect(await readFile(join(dataRoot, backupName ?? '', 'package/bin/codebuddy'), 'utf8')).toBe(
      'working'
    )

    const orphanStaging = join(
      dataRoot,
      'codebuddy-managed.staging-123e4567-e89b-42d3-a456-426614174000'
    )
    await mkdir(orphanStaging)
    const lookAlike = join(dataRoot, 'codebuddy-managed.backup-not-ours')
    await mkdir(lookAlike)
    await writeFile(join(lookAlike, 'keep-me'), 'not-ours')
    const uuidFile = join(dataRoot, 'codebuddy-managed.backup-223e4567-e89b-42d3-a456-426614174000')
    await writeFile(uuidFile, 'not-a-directory')

    await uninstallManagedCodeBuddy(dataRoot)
    await expect(access(join(dataRoot, backupName ?? ''))).rejects.toThrow()
    await expect(access(orphanStaging)).rejects.toThrow()
    expect(await readFile(join(lookAlike, 'keep-me'), 'utf8')).toBe('not-ours')
    expect(await readFile(uuidFile, 'utf8')).toBe('not-a-directory')
  })
})
