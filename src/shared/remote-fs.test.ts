import { describe, expect, it } from 'vitest'

import {
  classifyRemoteError,
  mtimeSecondsToMs,
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
