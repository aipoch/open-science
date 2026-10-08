import { describe, expect, it } from 'vitest'

import { notebookFolderAccessPath } from './folder-access'

describe('notebookFolderAccessPath', () => {
  const diagnostic =
    '<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: /private/token.txt Filesystem access failed; native permissions.\n</sandbox_violations>'

  it.each([
    { stdout: diagnostic },
    { output: { stderr: diagnostic } },
    { metadata: diagnostic },
    { stderr: diagnostic, exitCode: 0 },
    { status: 'completed', stderr: diagnostic },
    { run: { status: 'completed', text: { stderr: diagnostic } } },
    { stderr: '<sandbox_violations>\n' + diagnostic.split('\n')[1] },
    { stderr: '<sandbox_violations>\nother\n</sandbox_violations>\n' + diagnostic.split('\n')[1] }
  ])(
    'does not promote arbitrary output or incomplete annotations to a folder request: %j',
    (result) => {
      expect(notebookFolderAccessPath(result, 'darwin')).toBeUndefined()
    }
  )

  it('reads only the execution result stderr or canonical run stderr', () => {
    expect(notebookFolderAccessPath({ status: 'failed', stderr: diagnostic }, 'darwin')).toBe(
      '/private/token.txt'
    )
    expect(
      notebookFolderAccessPath(
        { run: { status: 'failed', text: { stderr: diagnostic } } },
        'darwin'
      )
    ).toBe('/private/token.txt')
  })

  it('extracts one structured sandbox path', () => {
    const path = String.raw`C:\Users\ewen\.config\helixlife\user-access-token.txt`
    expect(
      notebookFolderAccessPath(
        {
          exitCode: 1,
          stderr: `<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} Filesystem access failed; native permissions.\n</sandbox_violations>`
        },
        'win32'
      )
    ).toBe(path)
  })

  it('ignores permission-looking command output without a sandbox annotation', () => {
    expect(
      notebookFolderAccessPath(
        { stderr: `EPERM: operation not permitted, open 'C:\\Users\\ewen\\token.txt'` },
        'win32'
      )
    ).toBeUndefined()
  })

  it('fails closed for multiple paths and filesystem roots', () => {
    const first = String.raw`C:\Users\ewen\one.txt`
    const second = String.raw`C:\Users\ewen\two.txt`
    expect(
      notebookFolderAccessPath(
        {
          stderr: `<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${first} Filesystem access failed;\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${second} Filesystem access failed;\n</sandbox_violations>`
        },
        'win32'
      )
    ).toBeUndefined()
    expect(
      notebookFolderAccessPath(
        {
          stderr:
            '<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: C:\\ Filesystem access failed;\n</sandbox_violations>'
        },
        'win32'
      )
    ).toBeUndefined()
  })
})
