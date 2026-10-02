import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { notebookFolderAccessPath } from './notebook-folder-access'

const diagnostic = (path: string): string =>
  `<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} Filesystem access failed; native permissions, read-only mounts, or the sandbox may be responsible.\n</sandbox_violations>\n`
const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run',
  cellId: 'cell',
  source: 'agent',
  kernelKind: 'bash',
  script: 'fixture-cli',
  status: 'failed',
  startedAt: 0,
  outputs: [],
  workingFiles: [],
  text: {
    stdout: '',
    stderr: diagnostic('/fixture/config/settings.json'),
    traceback: '',
    plain: []
  },
  ...overrides
})

describe('Notebook folder recovery candidate', () => {
  it.each([
    ['linux', '/fixture/config/settings.json'],
    ['darwin', '/fixture/config with spaces/settings.json'],
    ['win32', String.raw`C:\fixture\config with spaces\settings.json`],
    ['win32', String.raw`\\fixture-host\share\config\settings.json`]
  ])('retains exact %s paths without guessing a folder', (platform, path) => {
    const record = run({ text: { ...run().text, stderr: diagnostic(path) } })
    expect(notebookFolderAccessPath(record, platform)).toBe(path)
  })

  it('uses annotated stderr while preserving JSON stdout byte for byte', () => {
    const stdout = JSON.stringify({
      error: "EPERM: operation not permitted, open '/fixture/config/settings.json'"
    })
    const record = run({ text: { ...run().text, stdout } })
    const before = structuredClone(record)
    expect(notebookFolderAccessPath(record, 'linux')).toBe('/fixture/config/settings.json')
    expect(record).toEqual(before)
  })

  it('handles completed shell results with nonzero exit codes and structured stderr', () => {
    const record = run({
      status: 'completed',
      exitCode: 1,
      outputs: [{ type: 'stream', name: 'stderr', text: diagnostic('/fixture/config') }]
    })
    record.text.stderr = ''
    expect(notebookFolderAccessPath(record, 'linux')).toBe('/fixture/config')
  })

  it.each(['queued', 'running', 'cancelled', 'completed'] as const)(
    'ignores %s results without a failure outcome',
    (status) => {
      expect(notebookFolderAccessPath(run({ status, exitCode: 0 }), 'linux')).toBeUndefined()
    }
  )

  it.each([
    'EPERM',
    'socket: Operation not permitted',
    'Permission denied (publickey).',
    'cat: /fixture/config: Permission denied'
  ])('does not classify ordinary output as a sandbox diagnostic: %s', (stderr) => {
    expect(
      notebookFolderAccessPath(run({ text: { ...run().text, stderr } }), 'linux')
    ).toBeUndefined()
  })

  it.each([
    {
      text: "Access is denied. Error: EPERM: operation not permitted, open 'C:\\Users\\fixture\\.config\\tool\\access-token.txt'",
      field: 'stderr' as const,
      platform: 'win32' as const,
      expected: 'C:\\Users\\fixture\\.config\\tool\\access-token.txt'
    },
    {
      text: "Error: EACCES: permission denied, open '/fixture/home/.config/tool/access-token.txt'",
      field: 'stdout' as const,
      platform: 'linux' as const,
      expected: '/fixture/home/.config/tool/access-token.txt'
    },
    {
      text: JSON.stringify({
        error:
          "EPERM: operation not permitted, open 'C:\\Users\\fixture\\.config\\tool\\access-token.txt'"
      }),
      field: 'stdout' as const,
      platform: 'win32' as const,
      expected: 'C:\\Users\\fixture\\.config\\tool\\access-token.txt'
    },
    {
      text: JSON.stringify({
        error:
          "EPERM: operation not permitted, open '\\\\fixture-server\\share\\config\\access-token.txt'"
      }),
      field: 'stdout' as const,
      platform: 'win32' as const,
      expected: '\\\\fixture-server\\share\\config\\access-token.txt'
    }
  ])(
    'offers recovery for an explicit absolute path in raw permission output',
    ({ text, field, platform, expected }) => {
      const base = run()
      const record = run({
        text: {
          ...base.text,
          stderr: field === 'stdout' ? '' : base.text.stderr,
          [field]: text
        }
      })
      expect(notebookFolderAccessPath(record, platform)).toBe(expected)
    }
  )

  it('suppresses recovery when raw permission output names multiple paths', () => {
    const base = run()
    const stderr =
      "EPERM: operation not permitted, open '/fixture/one/access-token.txt': permission denied; " +
      "EPERM: operation not permitted, open '/fixture/two/access-token.txt': permission denied"
    const record = run({ text: { ...base.text, stderr } })
    expect(notebookFolderAccessPath(record, 'linux')).toBeUndefined()
  })

  it('suppresses recovery when one raw permission error contains source and destination paths', () => {
    const base = run()
    const stderr =
      "EACCES: permission denied, rename '/fixture/source/access-token.txt' -> '/fixture/destination/access-token.txt'"
    const record = run({ text: { ...base.text, stderr } })
    expect(notebookFolderAccessPath(record, 'linux')).toBeUndefined()
  })

  it.each(['relative/config', '/', '/fixture/..', '/fixture/\u0000config'])(
    'rejects an unsafe or broad path: %s',
    (path) => {
      expect(
        notebookFolderAccessPath(
          run({ text: { ...run().text, stderr: diagnostic(path) } }),
          'linux'
        )
      ).toBeUndefined()
    }
  )

  it('rejects ambiguous candidates but deduplicates flattened and structured diagnostics', () => {
    expect(
      notebookFolderAccessPath(
        run({ outputs: [{ type: 'stream', name: 'stderr', text: diagnostic('/fixture/other') }] }),
        'linux'
      )
    ).toBeUndefined()
    expect(
      notebookFolderAccessPath(
        run({
          outputs: [
            {
              type: 'error',
              name: 'Error',
              message: diagnostic('/fixture/config/settings.json'),
              traceback: ''
            }
          ]
        }),
        'linux'
      )
    ).toBe('/fixture/config/settings.json')
  })

  it('does not reinterpret WSL paths as host folders', () => {
    expect(
      notebookFolderAccessPath(
        run({
          shellRuntime: {
            kind: 'wsl2-bash',
            distro: 'fixture',
            profileId: 'fixture',
            user: 'fixture'
          }
        }),
        'win32'
      )
    ).toBeUndefined()
    expect(notebookFolderAccessPath(run(), 'win32')).toBeUndefined()
  })
})
