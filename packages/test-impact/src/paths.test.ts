import { expect, it } from 'vitest'
import path from 'node:path'
import { assertPortablePaths, isInside } from './paths.js'
import { parseConfiguration } from './configuration.js'

it('rejects traversal, nonportable names and case/Unicode collisions', () => {
  for (const file of [
    '../escape',
    '/absolute',
    'a//b',
    'a/./b',
    'a/../b',
    'C:/escape',
    'a\\b',
    'nul.ts',
    'COM1.txt',
    'LPT¹.js',
    'trailing.',
    'trailing ',
    'a\tb',
    '.git/config',
    'NODE_MODULES/a.js',
    'a:b.js'
  ])
    expect(() => assertPortablePaths([file]), file).toThrow()
  for (const files of [
    ['A/index.ts', 'a/other.ts'],
    ['é.ts', 'e\u0301.ts']
  ])
    expect(() => assertPortablePaths(files)).toThrow('collision')
  expect(() => assertPortablePaths(['space name.ts', '雪.ts', 'src/index.ts'])).not.toThrow()
})

it('handles POSIX and Windows sibling, drive and UNC containment', () => {
  expect(isInside('/tmp/root', '/tmp/root/a', path.posix)).toBe(true)
  expect(isInside('/tmp/root', '/tmp/root-other/a', path.posix)).toBe(false)
  expect(isInside('C:\\root', 'C:\\root\\a', path.win32)).toBe(true)
  for (const target of ['C:\\root-other\\a', 'C:\\a', 'D:\\root\\a', '\\\\server\\share\\a'])
    expect(isInside('C:\\root', target, path.win32)).toBe(false)
  expect(isInside('\\\\server\\share\\root', '\\\\server\\share\\root\\a', path.win32)).toBe(true)
  expect(isInside('\\\\server\\share\\root', '\\\\server\\other\\root\\a', path.win32)).toBe(false)
})

it('accepts only bounded JSON configuration, never candidate config code or escaping paths', () => {
  for (const value of [
    null,
    [],
    { extends: 'candidate.js' },
    { packageRegistry: '../outside.json' },
    { sourcePaths: { alias: ['/outside'] } },
    { sourcePaths: { alias: [] } },
    { sourcePaths: { alias: ['a/**'] } }
  ])
    expect(() => parseConfiguration(value)).toThrow()
  expect(parseConfiguration({ sourcePaths: { '@/*': ['src/*'] } }).sourcePaths).toEqual({
    '@/*': ['src/*']
  })
})
