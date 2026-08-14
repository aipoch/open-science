import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { decodeDataPath, encodeDataPath } from './data-path'

const ROOT = '/data/open-science'

describe('data-path sentinel codec', () => {
  it('encodes a path under the data root to a $DATA sentinel', () => {
    expect(encodeDataPath(`${ROOT}/artifacts/p/s/m/plot.png`, ROOT)).toBe(
      '$DATA/artifacts/p/s/m/plot.png'
    )
  })
  it('leaves external absolute paths unchanged', () => {
    expect(encodeDataPath('/Users/x/external/file.csv', ROOT)).toBe('/Users/x/external/file.csv')
  })
  it
    .runIf(process.platform !== 'win32')
    .each([`${ROOT}/uploads/folder\\name.txt`, `${ROOT}/uploads/c:notes.txt`])(
    'leaves an in-root path with a non-portable filename unchanged: %s',
    (absolute) => {
      expect(encodeDataPath(absolute, ROOT)).toBe(absolute)
    }
  )
  it('is idempotent on an already-encoded sentinel, regardless of the given root', () => {
    expect(encodeDataPath('$DATA/artifacts/x', '/data/os')).toBe('$DATA/artifacts/x')
  })
  it('normalizes a portable encoded sentinel', () => {
    expect(encodeDataPath('$DATA/uploads/./nested//file.txt', ROOT)).toBe(
      '$DATA/uploads/nested/file.txt'
    )
    expect(decodeDataPath('$DATA/uploads/./nested//file.txt', ROOT)).toBe(
      join(ROOT, 'uploads/nested/file.txt')
    )
  })
  it('decodes a $DATA sentinel against the current data root', () => {
    // decode joins host-natively (backslashes on Windows), so derive the expected the same way.
    expect(decodeDataPath('$DATA/uploads/f.txt', ROOT)).toBe(join(ROOT, 'uploads/f.txt'))
  })
  it.each([
    '$DATA/../outside.txt',
    '$DATA/safe/../../outside.txt',
    '$DATA/C:/Windows/system.ini',
    '$DATA/c:relative.txt',
    '$DATA//server/share/file.txt',
    '$DATA/\\\\server\\share\\file.txt',
    '$DATA/folder\\file.txt'
  ])('rejects a non-portable or escaping sentinel: %s', (stored) => {
    expect(() => decodeDataPath(stored, ROOT)).toThrow(
      /portable relative path within the data root/
    )
    expect(() => encodeDataPath(stored, ROOT)).toThrow(
      /portable relative path within the data root/
    )
  })
  it('round-trips against a different root (relocation)', () => {
    const enc = encodeDataPath(`${ROOT}/runtime/env`, ROOT)
    expect(decodeDataPath(enc, '/mnt/new')).toBe(join('/mnt/new', 'runtime/env'))
  })
  it('passes through undefined', () => {
    expect(encodeDataPath(undefined, ROOT)).toBeUndefined()
    expect(decodeDataPath(undefined, ROOT)).toBeUndefined()
  })
})
