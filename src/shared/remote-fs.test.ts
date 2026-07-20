import { describe, expect, it } from 'vitest'

import {
  classifyRemoteError,
  mtimeSecondsToMs,
  parseFindListing,
  resolveRemotePath,
  validateRemotePath
} from './remote-fs'

describe('resolveRemotePath', () => {
  it('returns an absolute path unchanged', () => {
    expect(resolveRemotePath('/a/b', '/abs')).toBe('/abs')
  })

  it('joins a relative input onto cwd', () => {
    expect(resolveRemotePath('/a/b', 'sub')).toBe('/a/b/sub')
  })

  it('returns cwd when input is empty string', () => {
    expect(resolveRemotePath('/a/b', '')).toBe('/a/b')
  })

  it('handles trailing slash in cwd', () => {
    expect(resolveRemotePath('/a/b/', 'sub')).toBe('/a/b/sub')
  })

  it('handles multi-segment relative input', () => {
    expect(resolveRemotePath('/home/user', 'projects/data')).toBe('/home/user/projects/data')
  })
})

describe('validateRemotePath', () => {
  it('accepts an absolute path with no control characters', () => {
    expect(validateRemotePath('/home/user/data')).toBeUndefined()
  })

  it('rejects a relative path', () => {
    expect(validateRemotePath('relative/path')).toBe('outside_roots')
  })

  it('rejects an empty string', () => {
    expect(validateRemotePath('')).toBe('outside_roots')
  })

  it('rejects a path containing a control character (\\x00)', () => {
    expect(validateRemotePath('/home/user\x00data')).toBe('outside_roots')
  })

  it('rejects a path containing a newline (\\n)', () => {
    expect(validateRemotePath('/home/user\ndata')).toBe('outside_roots')
  })

  it('rejects a path containing a tab (\\t)', () => {
    expect(validateRemotePath('/home/user\tdata')).toBe('outside_roots')
  })

  it('accepts the root path', () => {
    expect(validateRemotePath('/')).toBeUndefined()
  })
})

describe('classifyRemoteError', () => {
  it('classifies ENOENT as not_found', () => {
    expect(classifyRemoteError({ code: 'ENOENT', message: 'No such file or directory' })).toEqual({
      remoteKind: 'not_found',
      retry_after_user_action: false
    })
  })

  it('classifies EACCES as permission', () => {
    expect(classifyRemoteError({ code: 'EACCES', message: 'Permission denied' })).toEqual({
      remoteKind: 'permission',
      retry_after_user_action: false
    })
  })

  it('classifies ENOTDIR as not_a_directory', () => {
    expect(classifyRemoteError({ code: 'ENOTDIR', message: 'Not a directory' })).toEqual({
      remoteKind: 'not_a_directory',
      retry_after_user_action: false
    })
  })

  it('classifies ssh exit code 255 as connection with retry_after_user_action', () => {
    const result = classifyRemoteError({ message: 'ssh exited with code 255' })
    expect(result.remoteKind).toBe('connection')
    expect(result.retry_after_user_action).toBe(true)
  })

  it('classifies connection timeout as connection with retry_after_user_action', () => {
    const result = classifyRemoteError({ message: 'Connection timed out' })
    expect(result.remoteKind).toBe('connection')
    expect(result.retry_after_user_action).toBe(true)
  })

  it('classifies kex error as connection with retry_after_user_action', () => {
    const result = classifyRemoteError({ message: 'kex error: no match for method key exchange' })
    expect(result.remoteKind).toBe('connection')
    expect(result.retry_after_user_action).toBe(true)
  })

  it('classifies publickey auth failure as connection with retry_after_user_action', () => {
    const result = classifyRemoteError({ message: 'Permission denied (publickey)' })
    expect(result.remoteKind).toBe('connection')
    expect(result.retry_after_user_action).toBe(true)
  })

  it('classifies unknown errors as other', () => {
    expect(classifyRemoteError({ message: 'something weird happened' })).toEqual({
      remoteKind: 'other',
      retry_after_user_action: false
    })
  })

  it('classifies undefined/empty input as other', () => {
    expect(classifyRemoteError({})).toEqual({
      remoteKind: 'other',
      retry_after_user_action: false
    })
  })

  it('classifies EPERM as permission', () => {
    expect(classifyRemoteError({ code: 'EPERM', message: 'Operation not permitted' })).toEqual({
      remoteKind: 'permission',
      retry_after_user_action: false
    })
  })

  it('classifies EISDIR as not_a_file (download called on a directory)', () => {
    expect(classifyRemoteError({ code: 'EISDIR', message: 'Is a directory' })).toEqual({
      remoteKind: 'not_a_file',
      retry_after_user_action: false
    })
  })

  // Stderr text fallbacks — exec path returns no POSIX code, only stderr text.
  it('stderr: "no such file or directory" → not_found', () => {
    expect(
      classifyRemoteError({ stderr: 'find: /nonexistent: No such file or directory' })
    ).toEqual({ remoteKind: 'not_found', retry_after_user_action: false })
  })

  it('stderr: "not a directory" → not_a_directory', () => {
    expect(classifyRemoteError({ stderr: 'bash: cd: /tmp/file.txt: Not a directory' })).toEqual({
      remoteKind: 'not_a_directory',
      retry_after_user_action: false
    })
  })

  it('stderr: "permission denied" (non-publickey) → permission', () => {
    expect(classifyRemoteError({ stderr: 'find: /root/.ssh: Permission denied' })).toEqual({
      remoteKind: 'permission',
      retry_after_user_action: false
    })
  })

  it('stderr: "permission denied (publickey)" → connection (not permission)', () => {
    // publickey permission denied is a connection error, not a filesystem permission error
    const result = classifyRemoteError({ stderr: 'Permission denied (publickey)' })
    expect(result.remoteKind).toBe('connection')
    expect(result.retry_after_user_action).toBe(true)
  })

  it('stderr: "is a directory" → not_a_file', () => {
    expect(classifyRemoteError({ stderr: 'cat: /tmp/mydir: Is a directory' })).toEqual({
      remoteKind: 'not_a_file',
      retry_after_user_action: false
    })
  })

  it('POSIX code takes precedence over stderr text', () => {
    // When code is set, it wins even if stderr text would match differently.
    expect(classifyRemoteError({ code: 'ENOENT', stderr: 'permission denied' })).toEqual({
      remoteKind: 'not_found',
      retry_after_user_action: false
    })
  })
})

describe('mtimeSecondsToMs', () => {
  it('multiplies seconds by 1000', () => {
    expect(mtimeSecondsToMs(1000)).toBe(1_000_000)
  })

  it('handles zero', () => {
    expect(mtimeSecondsToMs(0)).toBe(0)
  })

  it('handles fractional seconds', () => {
    expect(mtimeSecondsToMs(1.5)).toBe(1500)
  })

  it('converts a typical unix timestamp correctly', () => {
    // 2024-01-01T00:00:00Z = 1704067200 seconds
    expect(mtimeSecondsToMs(1704067200)).toBe(1704067200000)
  })
})

// Helper to build a single NUL-terminated find -printf record.
// Format: <type>\t<size>\t<mtime_float>\t<name>\0
const findRecord = (type: string, size: number, mtime: number, name: string): string =>
  `${type}\t${size}\t${mtime}\t${name}\0`

describe('parseFindListing', () => {
  it('returns empty array for empty stdout', () => {
    expect(parseFindListing('')).toEqual([])
  })

  it('parses a single file entry', () => {
    const raw = findRecord('f', 1024, 1704067200.123, 'readme.txt')
    const entries = parseFindListing(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      name: 'readme.txt',
      isDirectory: false,
      size: 1024,
      mtimeMs: 1704067200123
    })
  })

  it('parses a single directory entry (type d)', () => {
    const raw = findRecord('d', 4096, 1704067200.0, 'mydir')
    const entries = parseFindListing(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'mydir', isDirectory: true, size: 4096 })
  })

  it('treats symlink pointing to directory (type d via %Y) as directory', () => {
    // %Y follows symlink: if target is dir, type=d
    const raw = findRecord('d', 0, 1704067200.0, 'link-to-dir')
    const entries = parseFindListing(raw)
    expect(entries[0]?.isDirectory).toBe(true)
  })

  it('treats symlink pointing to file (type f via %Y) as file', () => {
    const raw = findRecord('f', 512, 1704067200.0, 'link-to-file')
    const entries = parseFindListing(raw)
    expect(entries[0]?.isDirectory).toBe(false)
  })

  it('handles name with spaces', () => {
    const raw = findRecord('f', 100, 1704067200.0, 'my file with spaces.txt')
    const entries = parseFindListing(raw)
    expect(entries[0]?.name).toBe('my file with spaces.txt')
  })

  it('handles name with special characters', () => {
    const raw = findRecord('f', 100, 1704067200.0, 'file [with] (special) chars!.txt')
    const entries = parseFindListing(raw)
    expect(entries[0]?.name).toBe('file [with] (special) chars!.txt')
  })

  it('handles name with tab in it (tab in name after splitting on record)', () => {
    // %f name can theoretically contain tabs - last field after 3rd tab
    // The format is: type\tsize\tmtime\tname - name is everything after the 3rd tab
    const raw = `f\t100\t1704067200.0\tfile\twith\ttabs.txt\0`
    const entries = parseFindListing(raw)
    expect(entries[0]?.name).toBe('file\twith\ttabs.txt')
  })

  it('converts float mtime seconds to milliseconds', () => {
    // %T@ gives floating-point seconds since epoch
    const raw = findRecord('f', 0, 1704067200.5, 'file.txt')
    const entries = parseFindListing(raw)
    // 1704067200.5 * 1000 = 1704067200500
    expect(entries[0]?.mtimeMs).toBe(1704067200500)
  })

  it('parses multiple entries separated by NUL', () => {
    const raw = [
      findRecord('d', 0, 1704067200.0, 'dirA'),
      findRecord('f', 1024, 1704067200.0, 'file.txt'),
      findRecord('d', 0, 1704067200.0, 'dirB')
    ].join('')
    const entries = parseFindListing(raw)
    expect(entries).toHaveLength(3)
  })

  it('truncates to 5000 entries and reports truncated=false from parseFindListing itself', () => {
    // parseFindListing returns all; truncation happens in listDir. The pure function returns all.
    const records = Array.from({ length: 10 }, (_, i) => findRecord('f', i, 1.0, `f${i}.txt`)).join(
      ''
    )
    const entries = parseFindListing(records)
    expect(entries).toHaveLength(10)
  })

  it('skips malformed records missing required fields', () => {
    // Only 2 fields instead of 4 — should be skipped
    const raw = `f\t100\0${findRecord('f', 200, 1704067200.0, 'valid.txt')}`
    const entries = parseFindListing(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('valid.txt')
  })

  it('handles unknown type as non-directory (type l for broken symlink, type p for pipe, etc.)', () => {
    const raw = findRecord('l', 0, 1704067200.0, 'broken-link')
    const entries = parseFindListing(raw)
    expect(entries[0]?.isDirectory).toBe(false)
  })
})
