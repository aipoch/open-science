import { describe, expect, it } from 'vitest'

import {
  MANAGED_DIFF_MAX_INPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_LINES,
  MANAGED_TEXT_EDIT_EXTENSIONS,
  MANAGED_TEXT_EDIT_MAX_BYTES,
  buildManagedVersionStoredFilename,
  createManagedVersionStorageTag,
  inspectManagedTextEditEligibility,
  isManagedVersionStoredFilename,
  isSafeManagedFileBasename,
  managedFileVersionHostCapability
} from './managed-file-versions'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('managed text edit eligibility', () => {
  it.each([
    'README.md',
    'README.markdown',
    'notes.TXT',
    'settings.json',
    'settings.yaml',
    'settings.yml',
    'settings.toml',
    'settings.ini',
    'settings.cfg',
    'settings.conf',
    'settings.xml',
    'analysis.js',
    'analysis.jsx',
    'analysis.ts',
    'analysis.tsx',
    'analysis.py',
    'analysis.r',
    'analysis.sql',
    'analysis.css',
    'run.sh',
    'run.bash',
    'run.zsh'
  ])('accepts strict UTF-8 text for the editable extension in %s', (filename) => {
    expect(inspectManagedTextEditEligibility(filename, encode('alpha\r\nbeta\r\n'))).toEqual({
      editable: true,
      byteLength: 13,
      text: 'alpha\r\nbeta\r\n',
      format: {
        hasUtf8Bom: false,
        newline: 'crlf',
        hasTrailingNewline: true
      }
    })
  })

  it.each([
    ['secrets.env', 'NOT_EDITABLE_EXTENSION'],
    ['report.csv', 'NOT_EDITABLE_EXTENSION'],
    ['page.html', 'NOT_EDITABLE_EXTENSION'],
    ['README', 'NOT_EDITABLE_EXTENSION']
  ] as const)('rejects excluded filename %s', (filename, reason) => {
    expect(inspectManagedTextEditEligibility(filename, encode('safe text'))).toEqual({
      editable: false,
      reason
    })
  })

  it('rejects an editable extension when the stable display name is not portable', () => {
    expect(inspectManagedTextEditEligibility('CON.md', encode('safe text'))).toEqual({
      editable: false,
      reason: 'UNSAFE_FILENAME'
    })
  })

  it('rejects invalid UTF-8 without replacement decoding', () => {
    expect(inspectManagedTextEditEligibility('notes.txt', Uint8Array.from([0xc3, 0x28]))).toEqual({
      editable: false,
      reason: 'INVALID_UTF8'
    })
  })

  it('rejects text containing NUL', () => {
    expect(inspectManagedTextEditEligibility('notes.txt', encode('before\0after'))).toEqual({
      editable: false,
      reason: 'CONTAINS_NUL'
    })
  })

  it('rejects text larger than the 2 MiB edit limit', () => {
    const oversized = new Uint8Array(MANAGED_TEXT_EDIT_MAX_BYTES + 1).fill(0x61)

    expect(inspectManagedTextEditEligibility('notes.txt', oversized)).toEqual({
      editable: false,
      reason: 'EDIT_LIMIT_EXCEEDED'
    })
  })

  it('accepts exactly 2 MiB and reports the encoded byte count for multibyte text', () => {
    expect(
      inspectManagedTextEditEligibility(
        'notes.txt',
        new Uint8Array(MANAGED_TEXT_EDIT_MAX_BYTES).fill(0x61)
      )
    ).toMatchObject({ editable: true, byteLength: MANAGED_TEXT_EDIT_MAX_BYTES })
    expect(inspectManagedTextEditEligibility('notes.txt', encode('界'))).toMatchObject({
      editable: true,
      byteLength: 3,
      text: '界'
    })
  })

  it('keeps the exported allowlist equal to the reviewed first-release set', () => {
    expect([...MANAGED_TEXT_EDIT_EXTENSIONS].sort()).toEqual(
      [
        'md',
        'markdown',
        'txt',
        'json',
        'yaml',
        'yml',
        'toml',
        'ini',
        'cfg',
        'conf',
        'xml',
        'js',
        'jsx',
        'ts',
        'tsx',
        'py',
        'r',
        'sql',
        'css',
        'sh',
        'bash',
        'zsh'
      ].sort()
    )
  })
})

describe('managed version storage names', () => {
  it('builds a storage tag from the injected secure random index source', () => {
    const indexes = [0, 10, 20, 29, 16, 28, 0, 25]

    expect(createManagedVersionStorageTag(() => indexes.shift()!)).toBe('vaku3q2az')
  })

  it('prefixes only a safe stable basename', () => {
    expect(buildManagedVersionStoredFilename('README.md', 'vk3m8q2az')).toBe('vk3m8q2az_README.md')
    expect(() => buildManagedVersionStoredFilename('../README.md', 'vk3m8q2az')).toThrow(
      /safe basename/
    )
  })

  it.each(['vabc1234', 'vabc123456', 'Vabc12345', 'vabc-2345', 'vabc_2345'])(
    'rejects invalid storage tag %s',
    (storageTag) => {
      expect(() => buildManagedVersionStoredFilename('README.md', storageTag)).toThrow(
        /storage tag/
      )
    }
  )

  it.each([
    'CON',
    'con.txt',
    'LPT9.log',
    'report?.md',
    'report<draft>.md',
    'report.md.',
    'report.md '
  ])('rejects non-portable basename %s', (filename) => {
    expect(isSafeManagedFileBasename(filename)).toBe(false)
    expect(() => buildManagedVersionStoredFilename(filename, 'vk3m8q2az')).toThrow(/safe basename/)
  })

  it('reserves ten UTF-8 bytes for the physical prefix within a 255-byte component', () => {
    const maximumUnicodeName = `${'界'.repeat(80)}.md`
    const oversizedUnicodeName = `${'界'.repeat(81)}.md`

    expect(encode(maximumUnicodeName).byteLength).toBe(243)
    expect(isSafeManagedFileBasename(maximumUnicodeName)).toBe(true)
    expect(
      encode(buildManagedVersionStoredFilename(maximumUnicodeName, 'vk3m8q2az')).byteLength
    ).toBe(253)
    expect(encode(oversizedUnicodeName).byteLength).toBe(246)
    expect(isSafeManagedFileBasename(oversizedUnicodeName)).toBe(false)
  })

  it('recognizes only portable managed storage filenames', () => {
    expect(isManagedVersionStoredFilename('vk3m8q2az_README.md')).toBe(true)
    expect(isManagedVersionStoredFilename('vABC12345_README.md')).toBe(false)
    expect(isManagedVersionStoredFilename('vk3m8q2az_CON.txt')).toBe(false)
    expect(isManagedVersionStoredFilename('vk3m8q2az_report?.md')).toBe(false)
    expect(isManagedVersionStoredFilename(`vk3m8q2az_${'界'.repeat(81)}.md`)).toBe(false)
  })
})

describe('managed file version host capability', () => {
  it('fails closed with a storage reason outside the Electron file-operator surface', () => {
    expect(managedFileVersionHostCapability(false)).toEqual({
      available: false,
      reason: 'STORAGE_UNAVAILABLE'
    })
    expect(managedFileVersionHostCapability(true)).toEqual({ available: true })
  })
})

describe('managed file text diff contract', () => {
  it('publishes explicit input and complete-output limits', () => {
    expect(MANAGED_DIFF_MAX_INPUT_BYTES).toBe(2 * 1024 * 1024)
    expect(MANAGED_DIFF_MAX_OUTPUT_LINES).toBe(20_000)
    expect(MANAGED_DIFF_MAX_OUTPUT_BYTES).toBe(500 * 1024)
  })
})
