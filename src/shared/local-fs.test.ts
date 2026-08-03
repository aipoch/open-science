import { describe, expect, it } from 'vitest'

import {
  describeLocalListingError,
  isSensitiveLocalPath,
  resolveLocalPath,
  sortLocalEntries,
  validateLocalPath,
  type LocalDirEntry
} from './local-fs'

describe('validateLocalPath', () => {
  it('accepts absolute paths', () => {
    expect(validateLocalPath('/Users/roxi/Documents')).toBeUndefined()
    expect(validateLocalPath('/')).toBeUndefined()
  })

  it('rejects non-absolute or empty input', () => {
    expect(validateLocalPath('relative/path')).toBe('not_absolute')
    expect(validateLocalPath('')).toBe('not_absolute')
    // @ts-expect-error runtime guard for non-string IPC input
    expect(validateLocalPath(undefined)).toBe('not_absolute')
  })

  it('rejects paths with control characters', () => {
    expect(validateLocalPath('/Users/roxi/\x00evil')).toBe('control_chars')
    expect(validateLocalPath('/Users/roxi/\x1ffile')).toBe('control_chars')
  })
})

describe('isSensitiveLocalPath', () => {
  it('flags credential dirs and files', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/project/.env')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.env.local')).toBe(true)
    expect(isSensitiveLocalPath('/etc/ssl/private/server.key')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/cert.pem')).toBe(true)
  })

  it('flags suffix-less secret files (SSH keys, cloud credentials)', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_rsa')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_ed25519')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.aws/credentials')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/.pgpass')).toBe(true)
    expect(isSensitiveLocalPath('/Users/roxi/keystore.p12')).toBe(true)
    // case-insensitive on the basename
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/ID_RSA')).toBe(true)
  })

  it('does not flag lookalikes that are not secrets', () => {
    expect(isSensitiveLocalPath('/Users/roxi/.ssh/id_rsa.pub')).toBe(false)
    expect(isSensitiveLocalPath('/Users/roxi/credentials.md')).toBe(false)
  })

  it('treats ordinary files as non-sensitive', () => {
    expect(isSensitiveLocalPath('/Users/roxi/Documents/notes.md')).toBe(false)
    expect(isSensitiveLocalPath('/Users/roxi/data.csv')).toBe(false)
    expect(isSensitiveLocalPath('/')).toBe(false)
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
    expect(resolveLocalPath('/Users/roxi', '/etc/hosts')).toBe('/etc/hosts')
  })

  it('joins relative input onto cwd', () => {
    expect(resolveLocalPath('/Users/roxi', 'Documents')).toBe('/Users/roxi/Documents')
    expect(resolveLocalPath('/Users/roxi/', 'Documents')).toBe('/Users/roxi/Documents')
    expect(resolveLocalPath('/', 'etc')).toBe('/etc')
  })

  it('returns cwd for empty input', () => {
    expect(resolveLocalPath('/Users/roxi', '')).toBe('/Users/roxi')
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
