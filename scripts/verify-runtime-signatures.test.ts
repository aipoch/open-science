import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyRuntimeSignatures } from './verify-runtime-signatures.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function macho(magic: string, filetype: number): Buffer {
  const header = Buffer.alloc(32)
  Buffer.from(magic, 'hex').copy(header)
  if (magic.startsWith('feed')) header.writeUInt32BE(filetype, 12)
  else header.writeUInt32LE(filetype, 12)
  return header
}

async function fixture(): Promise<string> {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    stdout: '',
    stderr: 'Authority=Developer ID Application: Example'
  })
  const root = await mkdtemp(join(tmpdir(), 'runtime-signatures-'))
  roots.push(root)
  return root
}

it('skips relocatable objects by header while verifying nested runtime code regardless of extension', async () => {
  const root = await fixture()
  const nested = join(root, 'build/Release/obj.target')
  await mkdir(nested, { recursive: true })
  for (const magic of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']) {
    await writeFile(join(nested, `${magic}.o`), macho(magic, 1))
    await writeFile(join(nested, `${magic}.renamed`), macho(magic, 1))
  }
  const payloads = ['node', 'addon.node', 'library.dylib', 'executable-disguised.o', 'universal']
  for (const [index, file] of payloads.entries())
    await writeFile(
      join(root, file),
      macho(index === 4 ? 'cafebabe' : 'cffaedfe', [2, 8, 6, 2, 0][index])
    )
  await writeFile(join(root, 'readme'), 'not native code')

  await verifyRuntimeSignatures(root)

  expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining(
      payloads.map((file) => ['--verify', '--strict', '--check-notarization', join(root, file)])
    )
  )
  expect(execFileSync).toHaveBeenCalledTimes(payloads.length)
  expect(spawnSync).toHaveBeenCalledTimes(payloads.length)
})

it('does not count object files as verified native payloads', async () => {
  const root = await fixture()
  await writeFile(join(root, 'probe.o'), macho('cffaedfe', 1))
  await expect(verifyRuntimeSignatures(root)).rejects.toThrow('No Mach-O payloads found')
  expect(execFileSync).not.toHaveBeenCalled()
})

it('rejects truncated Mach-O headers instead of inferring an object type from missing bytes', async () => {
  const root = await fixture()
  await writeFile(join(root, 'truncated'), Buffer.from('cffaedfe', 'hex'))
  await expect(verifyRuntimeSignatures(root)).rejects.toThrow('Truncated Mach-O header')
  expect(execFileSync).not.toHaveBeenCalled()
})

it('still rejects unsigned runtime code and non-Developer-ID signatures', async () => {
  const root = await fixture()
  await writeFile(join(root, 'addon.node'), macho('cffaedfe', 8))
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('code object is not signed at all')
  })
  await expect(verifyRuntimeSignatures(root)).rejects.toThrow('code object is not signed at all')
  vi.mocked(spawnSync).mockReturnValueOnce({
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    stdout: '',
    stderr: 'Signature=adhoc'
  })
  await expect(verifyRuntimeSignatures(root)).rejects.toThrow('Missing Developer ID')
})
