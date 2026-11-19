import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { NotebookShellProcessAdapter } from './shell-process'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'

configureTestRuntimeMetadata()

const converter = resolve('resources/skills/docx-generation/scripts/export-word-pdf.ps1')
const quote = (path: string): string => `'${path.replaceAll("'", "''")}'`

it.skipIf(process.platform !== 'win32' || process.env.OPEN_SCIENCE_TEST_WORD_PDF !== '1')(
  'reaps its own Word, unlocks the source and retains unrelated Word processes after export times out',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-word-pdf-'))
    // Standard Windows PowerShell, regardless of protection previously configured on the host.
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    const registry = new ShellProcessOwnershipRegistry(root)
    const adapter = new NotebookShellProcessAdapter('win32', owner, registry)
    const powershell = join(
      process.env.SystemRoot!,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const ps = async (code: string): Promise<string> =>
      (
        await promisify(execFile)(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(code, 'utf16le').toString('base64')
          ],
          { windowsHide: true, timeout: 10_000 }
        )
      ).stdout.trim()
    const input = join(root, 'test input.docx')
    const output = join(root, 'test output.pdf')
    const timedOutOutput = join(root, 'timed out output.pdf')
    const openExclusive = (path: string): Promise<string> =>
      ps(
        `$s = [IO.File]::Open(${quote(path)}, 'Open', 'ReadWrite', 'None'); $s.Dispose(); 'unlocked'`
      )
    const request = {
      runtimeBinding: { kind: 'powershell' as const, version: '5.1' as const },
      projectId: 'word-pdf',
      sessionId: 'word-pdf',
      cwd: root,
      handoffDir: root,
      runtimeRoot: join(root, 'runtime')
    }
    const invoke = (script: string, pdf: string): string =>
      `& ${quote(script)} -InputDocx ${quote(input)} -OutputPdf ${quote(pdf)}`
    const wordProcesses = async (): Promise<string[]> =>
      (
        await ps(
          `Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToUniversalTime().Ticks)" }`
        )
      )
        .split(/\r?\n/u)
        .filter(Boolean)
    try {
      await copyFile(resolve('test/fixtures/docx-report.docx'), input)
      const initialWord = await wordProcesses()
      expect(
        initialWord.length,
        'Open an unrelated Word instance before this test'
      ).toBeGreaterThan(0)
      const run = await adapter.execute({
        ...request,
        runId: 'export',
        command: invoke(converter, output),
        timeoutMs: 60_000
      })
      expect(run, JSON.stringify(run)).toMatchObject({ exitCode: 0 })
      const pdf = await readFile(output)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(await openExclusive(input)).toBe('unlocked')
      const refused = await adapter.execute({
        ...request,
        runId: 'existing-output',
        command: invoke(converter, output),
        timeoutMs: 15_000
      })
      expect(refused.stderr).toContain('Output must be a new PDF filename')
      expect(await readFile(output)).toEqual(pdf)

      // Suspend the real converter with a real document open, at the point of export.
      const source = await readFile(converter, 'utf8')
      const line = '    $document.ExportAsFixedFormat($stagedPdf, 17)'
      expect(source).toContain(line)
      const stalled = join(root, 'stalled-export.ps1')
      await writeFile(
        stalled,
        source.replace(
          line,
          `    try {
        $probe = [IO.File]::Open($inputPath, 'Open', 'ReadWrite', 'None')
        $probe.Dispose()
        throw 'Word did not lock the input document.'
    } catch [IO.IOException] {
        if (($_.Exception.HResult -band 0xffff) -notin 32, 33) { throw }
    }
    Write-Output "WORD_EXPORT_LOCKED $($child.Id) $($child.StartTime.ToUniversalTime().Ticks)"
    Start-Sleep -Seconds 120
${line}`
        )
      )
      const expired = await adapter.execute({
        ...request,
        runId: 'timeout',
        command: invoke(stalled, timedOutOutput),
        timeoutMs: 20_000
      })
      const ownedWord = /WORD_EXPORT_LOCKED (\d+ \d+)/u.exec(expired.stdout)?.[1]
      expect(ownedWord, JSON.stringify(expired)).toBeDefined()
      expect(initialWord).not.toContain(ownedWord)
      expect(expired.ownedTreeReaped).not.toBe(false)
      expect(expired.stderr).toContain('timed out after 20000ms')
      expect(expired.stderr).not.toContain('SHELL_CLEANUP_INCOMPLETE')
      const remaining = await wordProcesses()
      expect(remaining).not.toContain(ownedWord)
      for (const existing of initialWord) expect(remaining).toContain(existing)
      expect(await openExclusive(input)).toBe('unlocked')
      await expect(readFile(timedOutOutput)).rejects.toMatchObject({ code: 'ENOENT' })
      const recovery = await adapter.execute({
        ...request,
        runId: 'after-timeout',
        command: 'Write-Output RECOVERED; exit 0',
        timeoutMs: 15_000
      })
      expect(recovery).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('RECOVERED') })
      expect(registry.hasReceipts()).toBe(false)
    } finally {
      try {
        const shutdown = await adapter.shutdown()
        await owner.dispose()
        expect(shutdown).toEqual({ reaped: true })
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  },
  130_000
)
