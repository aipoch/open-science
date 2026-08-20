import { describe, expect, it, vi } from 'vitest'
import {
  classifyProcessName,
  parseCpuTimeSeconds,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  readProcessTree,
  selectProcessTree
} from './process-snapshot'

describe('runtime performance process snapshots', () => {
  it('parses portable POSIX process rows without retaining executable paths', () => {
    const processes = parsePosixProcessTable(`
      10     1   2048  00:01:02 /Applications/Open Science (DEV).app/Contents/MacOS/Open Science (DEV)
      11    10   1024  01:02.50 /usr/local/bin/codex
      12    11    512  2-03:04:05 /usr/bin/python3.12
      invalid row
    `)

    expect(processes).toEqual([
      { pid: 10, parentPid: 1, rssKb: 2048, cumulativeCpuSeconds: 62, kind: 'electron' },
      { pid: 11, parentPid: 10, rssKb: 1024, cumulativeCpuSeconds: 62.5, kind: 'agent' },
      {
        pid: 12,
        parentPid: 11,
        rssKb: 512,
        cumulativeCpuSeconds: 183_845,
        kind: 'python'
      }
    ])
    expect(JSON.stringify(processes)).not.toContain('/Applications')
    expect(JSON.stringify(processes)).not.toContain('/usr/local')
  })

  it('parses Windows cumulative CPU ticks and working sets', () => {
    const processes = parseWindowsProcessTable(
      JSON.stringify([
        {
          ProcessId: 20,
          ParentProcessId: 10,
          WorkingSetSize: 2_097_152,
          KernelModeTime: 15_000_000,
          UserModeTime: 25_000_000,
          Name: 'opencode.exe'
        }
      ])
    )

    expect(processes).toEqual([
      { pid: 20, parentPid: 10, rssKb: 2048, cumulativeCpuSeconds: 4, kind: 'agent' }
    ])
  })

  it('selects only the root and its transitive descendants', () => {
    const processes = parsePosixProcessTable(`
      10 1 100 0:01 Electron
      11 10 100 0:01 node
      12 11 100 0:01 python3
      99 1 100 0:01 other
    `)

    expect(selectProcessTree(processes, 10).map((process) => process.pid)).toEqual([10, 11, 12])
  })

  it('fails closed when the process table cannot be read', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('private command failure'))

    await expect(readProcessTree(10, 'darwin', runner)).resolves.toEqual({
      rootPid: 10,
      complete: false,
      processes: []
    })
  })

  it('supports the CPU time formats emitted by macOS and Linux ps', () => {
    expect(parseCpuTimeSeconds('03.50')).toBe(3.5)
    expect(parseCpuTimeSeconds('02:03.50')).toBe(123.5)
    expect(parseCpuTimeSeconds('01:02:03')).toBe(3723)
    expect(parseCpuTimeSeconds('2-01:02:03')).toBe(176_523)
    expect(parseCpuTimeSeconds('not-a-time')).toBeUndefined()
  })

  it('maps executable names to bounded categories only', () => {
    expect(classifyProcessName('/private/user-project/secret-tool')).toBe('other')
    expect(classifyProcessName('/usr/local/bin/claude')).toBe('agent')
    expect(classifyProcessName('Rscript')).toBe('r')
    expect(classifyProcessName('PowerShell.EXE')).toBe('shell')
  })
})
