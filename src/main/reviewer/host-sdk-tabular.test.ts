// Direct unit tests for parseTabular's RFC 4180 handling: quoted fields containing the delimiter,
// escaped double-quotes, embedded newlines, and duplicate headers. The HTTP-level column tests live
// in host-sdk.test.ts; these isolate the parser so quoting edge cases are pinned precisely.

import { describe, it, expect } from 'vitest'

import { parseTabular } from './host-sdk'

describe('parseTabular — RFC 4180', () => {
  it('parses a simple CSV without quotes', () => {
    const { columns, rowCount } = parseTabular('a,b\n1,2\n3,4\n', ',')
    expect(rowCount).toBe(2)
    expect(columns).toEqual({ a: ['1', '3'], b: ['2', '4'] })
  })

  it('keeps a delimiter inside a quoted field in the same column', () => {
    const { columns, rowCount } = parseTabular('name,city\n"Smith, John",NYC\n', ',')
    expect(rowCount).toBe(1)
    expect(columns).toEqual({ name: ['Smith, John'], city: ['NYC'] })
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    const { columns } = parseTabular('quote\n"She said ""hi"""\n', ',')
    expect(columns.quote).toEqual(['She said "hi"'])
  })

  it('keeps an embedded newline inside a quoted field as one row', () => {
    const { columns, rowCount } = parseTabular('a,b\n"line1\nline2",x\n', ',')
    expect(rowCount).toBe(1)
    expect(columns.a).toEqual(['line1\nline2'])
    expect(columns.b).toEqual(['x'])
  })

  it('does not collapse duplicate headers — later columns are suffixed', () => {
    const { columns } = parseTabular('id,id,name\n1,2,x\n', ',')
    expect(columns.id).toEqual(['1'])
    expect(columns.id_2).toEqual(['2'])
    expect(columns.name).toEqual(['x'])
  })

  it('handles quoted fields with the tab delimiter (TSV)', () => {
    const { columns } = parseTabular('name\tnote\n"a\tb"\thello\n', '\t')
    expect(columns.name).toEqual(['a\tb'])
    expect(columns.note).toEqual(['hello'])
  })

  it('ignores blank lines and a trailing newline', () => {
    const { columns, rowCount } = parseTabular('a,b\n1,2\n\n', ',')
    expect(rowCount).toBe(1)
    expect(columns).toEqual({ a: ['1'], b: ['2'] })
  })

  it('tolerates CRLF line endings', () => {
    const { columns, rowCount } = parseTabular('a,b\r\n1,2\r\n', ',')
    expect(rowCount).toBe(1)
    expect(columns).toEqual({ a: ['1'], b: ['2'] })
  })

  it('pads short rows with empty strings', () => {
    const { columns } = parseTabular('a,b,c\n1,2\n', ',')
    expect(columns.a).toEqual(['1'])
    expect(columns.b).toEqual(['2'])
    expect(columns.c).toEqual([''])
  })
})
