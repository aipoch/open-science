import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'

const requireRepo = createRequire(import.meta.url)
const childProcess = requireRepo('child_process') as typeof import('node:child_process')
const { verifySignature } = requireRepo(
  'electron-updater/out/windowsExecutableCodeSignatureVerifier'
) as {
  verifySignature: (
    publishers: string[],
    file: string,
    logger: typeof log
  ) => Promise<string | null>
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('rejects verification errors even when PowerShell itself is unavailable', async () => {
  const failure = Object.assign(new Error('PowerShell unavailable'), { code: 'ENOENT' })
  vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    callback(failure, '', '')
    return {} as ReturnType<typeof childProcess.execFile>
  })
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
    throw failure
  })
  await expect(
    verifySignature(['Fixture Publisher'], 'C:\\path\\to\\installer.exe', log)
  ).rejects.toThrow('PowerShell unavailable')
})

describe.runIf(process.platform === 'win32')('installed updater Authenticode verification', () => {
  it('validates a signed system binary with an empty PATH and preserves publisher checks', async () => {
    const executable = resolveWindowsPowerShellExecutable()
    vi.stubEnv('PATH', '')
    await expect(verifySignature(['Microsoft Windows'], executable, log)).resolves.toBeNull()
    await expect(
      verifySignature(['Unrelated Fixture Publisher'], executable, log)
    ).resolves.toContain('publisherNames:')
  }, 60_000)

  it('rejects an unsigned asset with Unicode and quoted path characters with an empty PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'signature-'))
    try {
      const file = join(root, "fixture-\u00e9-'-.exe")
      await writeFile(file, 'unsigned fixture')
      vi.stubEnv('PATH', '')
      await expect(verifySignature(['Fixture Publisher'], file, log)).resolves.toContain(
        'publisherNames:'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
