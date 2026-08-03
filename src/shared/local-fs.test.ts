import { describe, expect, it } from 'vitest'

import {
  describeLocalListingError,
  isLocalPathRoot,
  isSensitiveLocalPath,
  parentLocalPath,
  resolveLocalPath,
  sameLocalDirectory,
  sortLocalEntries,
  validateLocalPath,
  type LocalDirEntry
} from './local-fs'

describe('validateLocalPath', () => {
  it('accepts absolute paths', () => {
    expect(validateLocalPath('/Users/roxi/Documents', 'darwin')).toBeUndefined()
    expect(validateLocalPath('/', 'linux')).toBeUndefined()
    expect(validateLocalPath('C:\\Users\\roxi\\Documents', 'win32')).toBeUndefined()
    expect(validateLocalPath('C:/Users/roxi/Documents', 'win32')).toBeUndefined()
    expect(validateLocalPath('\\\\server\\share\\Documents', 'win32')).toBeUndefined()
    expect(validateLocalPath('//server/share/Documents', 'win32')).toBeUndefined()
  })

  it('rejects non-absolute or empty input', () => {
    expect(validateLocalPath('relative/path', 'linux')).toBe('not_absolute')
    expect(validateLocalPath('C:relative\\path', 'win32')).toBe('not_absolute')
    expect(validateLocalPath('\\root-relative', 'win32')).toBe('not_absolute')
    expect(validateLocalPath('\\\\server', 'win32')).toBe('not_absolute')
    expect(validateLocalPath('C:\\Users\\roxi', 'linux')).toBe('not_absolute')
    expect(validateLocalPath('/Users/roxi', 'win32')).toBe('not_absolute')
    expect(validateLocalPath('', 'linux')).toBe('not_absolute')
    // @ts-expect-error runtime guard for non-string IPC input
    expect(validateLocalPath(undefined, 'linux')).toBe('not_absolute')
  })

  it('rejects paths with control characters', () => {
    expect(validateLocalPath('/Users/roxi/\x00evil', 'linux')).toBe('control_chars')
    expect(validateLocalPath('/Users/roxi/\x1ffile', 'linux')).toBe('control_chars')
  })
})

describe('isSensitiveLocalPath', () => {
  it('flags credential dirs and files', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/project/.env', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.env.local', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/etc/ssl/private/server.key', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/cert.pem', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('C:\\Users\\roxi\\.ssh', 'win32')).toBe(true)
  })

  it('flags suffix-less secret files (SSH keys, cloud credentials)', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_rsa', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_ed25519', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.aws/credentials', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.pgpass', 'linux')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/keystore.p12', 'linux')).toBe(true)
    // case-insensitive on the basename
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/ID_RSA', 'linux')).toBe(true)
  })

  it('does not flag lookalikes that are not secrets', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_rsa.pub', 'linux')).toBe(false)
    expect(isSensitiveLocalPath('/Users/roxi/credentials.md', 'linux')).toBe(false)
  })

  it('treats ordinary files as non-sensitive', () => {
    expect(isSensitiveLocalPath('/Users/roxi/Documents/notes.md', 'linux')).toBe(false)
    expect(isSensitiveLocalPath('/Users/roxi/data.csv', 'linux')).toBe(false)
    expect(isSensitiveLocalPath('/', 'linux')).toBe(false)
    expect(isSensitiveLocalPath('/tmp/folder\\.ssh', 'linux')).toBe(false)
  })
})

describe('sortLocalEntries', () => {
  it('orders directories first, then case-insensitive alphabetical', () => {
    const entries: LocalDirEntry[] = [
      { name: 'zebra.txt', isDirectory: false, size: 1, mtimeMs: 0 },
      { name: 'Apple', isDirectory: true, size: 0, mtimeMs: 0 },
      { name: 'banana.md', isDirectory: false, size: 2, mtimeMs: 0 },
      { name: 'apricot', isDirectory: true, size: 0, mtimeMs: 0 }
    ]
    expect(sortLocalEntries(entries).map((e) => e.name)).toEqual([
      'Apple',
      'apricot',
      'banana.md',
      'zebra.txt'
    ])
  })

  it('does not mutate the input array', () => {
    const entries: LocalDirEntry[] = [
      { name: 'b', isDirectory: false, size: 0, mtimeMs: 0 },
      { name: 'a', isDirectory: false, size: 0, mtimeMs: 0 }
    ]
    sortLocalEntries(entries)
    expect(entries.map((e) => e.name)).toEqual(['b', 'a'])
  })
})

describe('resolveLocalPath', () => {
  it('returns absolute input unchanged', () => {
    expect(resolveLocalPath('/Users/roxi', '/etc/hosts', 'linux')).toBe('/etc/hosts')
  })

  it('joins relative input onto cwd', () => {
    expect(resolveLocalPath('/Users/roxi', 'Documents', 'linux')).toBe('/Users/roxi/Documents')
    expect(resolveLocalPath('/Users/roxi/', 'Documents', 'linux')).toBe('/Users/roxi/Documents')
    expect(resolveLocalPath('/', 'etc', 'linux')).toBe('/etc')
  })

  it('returns cwd for empty input', () => {
    expect(resolveLocalPath('/Users/roxi', '', 'linux')).toBe('/Users/roxi')
  })

  it('resolves Windows drive and UNC paths', () => {
    expect(resolveLocalPath('C:\\Users\\roxi', 'Documents', 'win32')).toBe(
      'C:\\Users\\roxi\\Documents'
    )
    expect(resolveLocalPath('C:\\Users\\roxi', 'D:\\Data', 'win32')).toBe('D:\\Data')
    expect(resolveLocalPath('\\\\server\\share', 'Documents', 'win32')).toBe(
      '\\\\server\\share\\Documents'
    )
    expect(resolveLocalPath('C:\\Users\\roxi', '//server/share', 'win32')).toBe('//server/share')
  })
})

describe('local path navigation', () => {
  it('finds parents and roots with host path semantics', () => {
    expect(parentLocalPath('/Users/roxi/Documents', 'linux')).toBe('/Users/roxi')
    expect(parentLocalPath('/tmp/folder\\name', 'linux')).toBe('/tmp')
    expect(parentLocalPath('/', 'linux')).toBe('/')
    expect(parentLocalPath('C:\\Users\\roxi', 'win32')).toBe('C:\\Users')
    expect(parentLocalPath('C:\\', 'win32')).toBe('C:\\')
    expect(parentLocalPath('\\\\server\\share\\Documents', 'win32')).toBe('\\\\server\\share')
    expect(parentLocalPath('//server/share/Documents', 'win32')).toBe('//server/share')
    expect(parentLocalPath('\\\\server\\share', 'win32')).toBe('\\\\server\\share')
    expect(isLocalPathRoot('C:\\', 'win32')).toBe(true)
    expect(isLocalPathRoot('//server/share/', 'win32')).toBe(true)
    expect(isLocalPathRoot('C:\\Users', 'win32')).toBe(false)
  })

  it('compares Windows directories case-insensitively and ignores trailing separators', () => {
    expect(sameLocalDirectory('/Users/roxi/', '/Users/roxi', 'linux')).toBe(true)
    expect(sameLocalDirectory('/tmp/folder\\', '/tmp/folder', 'linux')).toBe(false)
    expect(sameLocalDirectory('C:\\Users\\Roxi\\', 'c:\\users\\roxi', 'win32')).toBe(true)
    expect(sameLocalDirectory('C:/Users/Roxi', 'c:\\users\\roxi', 'win32')).toBe(true)
    expect(sameLocalDirectory('//server/share', '\\\\SERVER\\share\\', 'win32')).toBe(true)
    expect(sameLocalDirectory('C:\\Users', 'D:\\Users', 'win32')).toBe(false)
  })
})

describe('describeLocalListingError', () => {
  // What listDir actually rejects with: Electron's IPC wrapper around the node errno text.
  const ipc = (body: string): string =>
    `Error invoking remote method 'local-fs:list-dir': Error: ${body}`

  it('maps a missing path to a plain sentence plus the path', () => {
    expect(
      describeLocalListingError(ipc("ENOENT: no such file or directory, realpath '/nope'"), '/nope')
    ).toEqual({ summary: 'No such folder:', path: '/nope' })
  })

  it('distinguishes not-a-directory, permission and symlink failures', () => {
    expect(describeLocalListingError(ipc('ENOTDIR: not a directory'), '/etc/hosts').summary).toBe(
      'Not a folder:'
    )
    expect(describeLocalListingError(ipc('EACCES: permission denied'), '/root').summary).toBe(
      "You don't have access to:"
    )
    expect(describeLocalListingError(ipc('EPERM: operation not permitted'), '/root').summary).toBe(
      "You don't have access to:"
    )
    expect(describeLocalListingError(ipc('ELOOP: too many symbolic links'), '/a').summary).toBe(
      'Too many symlinks to follow:'
    )
  })

  it('maps the validation rejections and omits the path for them', () => {
    expect(describeLocalListingError(ipc('Local path must be absolute.'), 'rel')).toEqual({
      summary: 'Enter an absolute path, starting at /.'
    })
    expect(describeLocalListingError(ipc('Local path contains invalid characters.'), '/a')).toEqual(
      {
        summary: 'That path contains invalid characters.'
      }
    )
  })

  it('keeps unrecognized text but strips the IPC wrapper', () => {
    expect(describeLocalListingError(ipc('EIO: i/o error'), '/a')).toEqual({
      summary: 'EIO: i/o error'
    })
  })

  it('falls back to a generic sentence when there is no message', () => {
    expect(describeLocalListingError('', '/a')).toEqual({ summary: 'Could not open that folder.' })
  })
})
