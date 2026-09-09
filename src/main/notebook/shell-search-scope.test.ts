import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePowerShellSearchCommands } from './powershell-search-parser'
import { NotebookShellProcessAdapter } from './shell-process'

vi.mock('./powershell-search-parser', () => ({ parsePowerShellSearchCommands: vi.fn() }))

// Portable contract fixtures for host admission; the Windows suite separately runs the OS parser.
describe('PowerShell search admission contract', () => {
  let root: string
  let cwd: string
  beforeEach(async () => {
    vi.mocked(parsePowerShellSearchCommands).mockReset()
    root = await mkdtemp(join(tmpdir(), 'powershell-search-scope-'))
    cwd = join(root, 'workspace')
    await mkdir(cwd)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    { name: 'Get-ChildItem', arguments: ['-LiteralPath', '..', '-Recurse'] },
    { name: 'gci', arguments: ['-Path', null, '-Recurse'] },
    { name: 'dir', arguments: ['../outside', '-Recurse'] },
    { name: 'where.exe', arguments: ['/r', '..', 'chart.png'] },
    { name: 'C:\\Windows\\System32\\where.exe', arguments: ['/r', '..', 'chart.png'] },
    { name: './where', arguments: ['/r', '..', 'chart.png'] },
    { name: 'where.exe', arguments: ['chart.png'] },
    { name: 'where', arguments: ['/r', '..', 'chart.png'] },
    { name: 'rg.exe', arguments: ['--ignore-file', '../outside/ignore', 'needle', '.'] },
    { name: 'rg.exe', arguments: ['-f', 'C:patterns', '.'] },
    { name: 'Get-ChildItem', arguments: ['HKLM:\\', '-Recurse'] },
    { name: 'Get-ChildItem', arguments: ['C:..', '-Recurse'] },
    { name: 'Get-ChildItem', arguments: ['FileSystem::C:\\', '-Recurse'] },
    { name: 'cmd.exe', arguments: ['/c', 'dir /s C:\\'] },
    { name: 'Get-ChildItem', arguments: ['-LiteralPath', '.', '..'] },
    { name: null, arguments: ['..'] }
  ])('rejects $name before starting the workload', async (entry) => {
    vi.mocked(parsePowerShellSearchCommands).mockResolvedValue([entry])
    const wrap = vi.fn().mockRejectedValue(new Error('must not reach sandbox'))
    const adapter = new NotebookShellProcessAdapter('win32', { wrap })
    await expect(
      adapter.prepare({
        command: 'fixture source',
        cwd,
        handoffDir: cwd,
        runtimeRoot: root,
        environment: {},
        sessionId: 's',
        projectId: 'p'
      })
    ).rejects.toThrow(/search scope denied/i)
    expect(wrap).not.toHaveBeenCalled()
  })

  it('checks literal scoped paths and preserves normal commands', async () => {
    vi.mocked(parsePowerShellSearchCommands).mockResolvedValue([
      { name: 'Get-ChildItem', arguments: ['-LiteralPath', '.', '-Recurse', '-Filter', '*.png'] },
      { name: 'where', arguments: ['Name', '-like', '*.csv'] },
      { name: 'WHERE', arguments: [null] },
      { name: 'where.exe', arguments: ['/r', '.', 'chart.png'] },
      { name: 'rg.exe', arguments: ['--ignore-file=./ignore', 'needle', '.'] },
      { name: 'Write-Output', arguments: ['documentation containing find /'] }
    ])
    const sentinel = new Error('stopped before workload')
    const wrap = vi.fn().mockRejectedValue(sentinel)
    const adapter = new NotebookShellProcessAdapter('win32', { wrap })
    await expect(
      adapter.prepare({
        command: 'fixture source',
        cwd,
        handoffDir: cwd,
        runtimeRoot: root,
        environment: {},
        sessionId: 's',
        projectId: 'p'
      })
    ).rejects.toBe(sentinel)
    expect(wrap).toHaveBeenCalledOnce()
  })
})
