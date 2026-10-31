import { describe, expect, it } from 'vitest'
import { normalizeLiteratureIdentifierKey } from '@aipoch/literature-citations/contracts'
import { parseLiteratureLink } from './literature-link'

describe('supported literature links', () => {
  it.each([
    [' 10.1038/NPHYS1170 ', '10.1038/nphys1170'],
    ['doi:10.1038/NPHYS1170', '10.1038/nphys1170'],
    ['10.1234/MIXED-Á', '10.1234/mixed-Á'],
    ['10.1234/á', '10.1234/á'],
    ['https://doi.org/10.1234/%C3%81', '10.1234/Á'],
    ['10.1234/İ', '10.1234/İ'],
    ['https://doi.org/10.1234/foo(bar)', '10.1234/foo(bar)'],
    ['10.1234/foo.', '10.1234/foo.'],
    ['10.1234/exampleCOPYRIGHT', '10.1234/examplecopyright'],
    ['10.1234/foo/../bar', '10.1234/foo/../bar'],
    ['https://doi.org/10.1234/foo..bar', '10.1234/foo..bar'],
    ['https://doi.org/10.1038%2Fnphys1170?utm_source=test#abstract', '10.1038/nphys1170'],
    ['https://arxiv.org/abs/2401.12345v2?context=cs', 'arxiv:2401.12345'],
    ['https://arxiv.org/pdf/2401.12345v3.pdf#page=2', 'arxiv:2401.12345'],
    ['https://www.arxiv.org/pdf/hep-th/9901001v1', 'arxiv:hep-th/9901001'],
    ['arXiv:2401.12345v2', 'arxiv:2401.12345']
  ])('normalizes %s', (input, expected) => {
    expect(parseLiteratureLink(input)).toBe(expected)
    if (!expected.startsWith('arxiv:'))
      expect(normalizeLiteratureIdentifierKey('doi', expected)).toBe(expected)
  })
  it.each([
    '',
    'https://example.com/10.1234/paper',
    'https://arxiv.org.evil.test/abs/2401.12345',
    'https://doi.org@127.0.0.1/10.1234/paper',
    'https://user@doi.org/10.1234/paper',
    'https://doi.org:8443/10.1234/paper',
    'file:///10.1234/paper',
    'https://arxiv.org/search/?query=2401.12345',
    'https://doi.org/%E0%A4%A',
    'https://arxiv.org/abs/2413.12345',
    '10.1234/has space',
    'https://doi.org/10.1234/pa\tper',
    'https://doi.org/10.1234/pa%00per',
    '10.1234/ｐａｐｅｒ',
    '10.1234/K',
    'https://doi.org/10.1234/%EF%BD%90%EF%BD%81%EF%BD%90%EF%BD%85%EF%BD%92',
    '10.1234/a\u0000b',
    '10.1234/' + 'a'.repeat(2048),
    'https://arxiv.org/abs/2401.12345v0'
  ])('rejects unsupported or malformed input %s', (input) => {
    expect(parseLiteratureLink(input)).toBeUndefined()
  })
  it.each([
    'https://doi.org/10.1234/foo/../bar',
    'https://doi.org/10.1234/./bar',
    'https://doi.org/10.1234/foo/%2e%2e/bar',
    'https://doi.org/10.1234/foo/.%2e/bar',
    'https://doi.org/10.1234/foo\\bar',
    'https://arxiv.org/ignored/../abs/2401.12345'
  ])('rejects URL parser path rewriting for %s', (input) => {
    expect(parseLiteratureLink(input)).toBeUndefined()
  })
})
