import { describe, expect, it, vi } from 'vitest'
import { createWindowsExecutableVerifier } from './windows-executable-trust'

type Execute = NonNullable<
  NonNullable<Parameters<typeof createWindowsExecutableVerifier>[0]>['execute']
>
const evidence = { status: 'Valid', publisher: "Different Publisher's Company", timestamped: true }
const environment = { SYSTEMROOT: 'C:\\Windows', psmodulepath: 'untrusted-modules' }
const executor = (value: unknown): Execute =>
  vi.fn(async () => ({ stdout: JSON.stringify(value), stderr: '' })) as unknown as Execute

describe('Windows executable trust', () => {
  it('uses configured identity and passes file paths as data through system PowerShell', async () => {
    const execute = executor(evidence)
    const verify = createWindowsExecutableVerifier({
      expectedPublisher: evidence.publisher,
      env: environment,
      execute
    })
    const path = "C:\\binary'; throw 'injection.exe"
    await verify(path)
    expect(execute).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', expect.any(String)],
      expect.objectContaining({
        timeout: 10_000,
        windowsHide: true,
        env: expect.objectContaining({
          OPEN_SCIENCE_AUTHENTICODE_PATH: path,
          PSMODULEPATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
        })
      })
    )
    const script = vi.mocked(execute).mock.calls[0][1]!.at(-1)!
    expect(script).toContain('$env:PSModulePath = $env:OPEN_SCIENCE_POWERSHELL_MODULE_PATH')
    expect(script).not.toContain(evidence.publisher)
    expect(script).not.toContain(path)
  })

  it.each([
    [{ ...evidence, status: 'HashMismatch' }, /signature status/],
    [{ ...evidence, publisher: 'Another Company' }, /publisher/],
    [{ ...evidence, timestamped: false }, /timestamp/],
    [{ ...evidence, timestamped: 'true' }, /timestamp/],
    [null, /signature status/]
  ])('rejects invalid trust evidence %j', async (value, error) => {
    await expect(
      createWindowsExecutableVerifier({
        expectedPublisher: evidence.publisher,
        env: environment,
        execute: executor(value)
      })('candidate.exe')
    ).rejects.toThrow(error as RegExp)
  })

  it('does not trust a runtime environment publisher when build configuration is absent', async () => {
    const execute = executor(evidence)
    await expect(
      createWindowsExecutableVerifier({
        env: { ...environment, AZURE_SIGNING_PUBLISHER: evidence.publisher },
        execute
      })('candidate.exe')
    ).rejects.toThrow(/configured publisher/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects blank configuration and missing system paths before executing a subprocess', async () => {
    const execute = executor(evidence)
    await expect(
      createWindowsExecutableVerifier({
        expectedPublisher: ' ',
        env: environment,
        execute
      })('candidate.exe')
    ).rejects.toThrow(/configured publisher/)
    await expect(
      createWindowsExecutableVerifier({
        expectedPublisher: evidence.publisher,
        env: {},
        execute
      })('candidate.exe')
    ).rejects.toThrow(/system PowerShell/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('propagates verifier process failures', async () => {
    const execute = vi.fn(async () => {
      throw new Error('PowerShell timed out')
    }) as unknown as Execute
    await expect(
      createWindowsExecutableVerifier({
        expectedPublisher: evidence.publisher,
        env: environment,
        execute
      })('candidate.exe')
    ).rejects.toThrow('PowerShell timed out')
  })
})

it.runIf(process.platform === 'win32')(
  'rejects an unsigned file through real Windows PowerShell',
  async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = await mkdtemp(join(tmpdir(), 'windows-trust-'))
    try {
      const path = join(directory, 'unsigned.exe')
      await writeFile(path, 'unsigned-test-fixture')
      await expect(
        createWindowsExecutableVerifier({ expectedPublisher: 'Test Publisher' })(path)
      ).rejects.toThrow('Invalid Authenticode signature status.')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000
)
