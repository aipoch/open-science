import { expect, it } from 'vitest'
import { PackageJsonSyntax } from './json-syntax'

const accepts = (text: string, split: number): boolean => {
  const syntax = new PackageJsonSyntax()
  syntax.write(text.slice(0, split))
  syntax.write(text.slice(split))
  return syntax.finish()
}

const documents = [
  '{}',
  '[]',
  'true',
  'false',
  'null',
  '0',
  '-0',
  '123456',
  '-2.123e+004',
  '1E-12',
  '"research"',
  String.raw`"\u0000\n\t\r\b\f\\\"\/"`,
  '{"noCredentials":true,"nested":[false,null,1,{"result":"研究"}]}',
  '{\n "noCredentials": false,\n "value": [0, 1]\n}',
  '{"apiKey":"synthetic-private-value","apiKey":true}',
  '',
  '{',
  '[',
  '"',
  '"\\',
  '"\\u123"',
  '"\\uZZZZ"',
  '"\\x41"',
  '"\n"',
  'undefined',
  'NaN',
  'Infinity',
  '+1',
  '01',
  '-01',
  '1.',
  '1e',
  '1e+',
  '.1',
  '1e1e1',
  '{"a" true}',
  '{"a":}',
  '{"a":true,}',
  '{"a":true false}',
  '{a:true}',
  '[true,]',
  '[,true]',
  '[true false]',
  '{]',
  '[}',
  'true false',
  '{}{}',
  '{"a":true}\u00a0',
  '{"a":true}\v',
  '{"a":true}suffix'
]

it.each(documents)('agrees with JSON.parse across every read boundary: %j', (text) => {
  let valid = true
  try {
    JSON.parse(text)
  } catch {
    valid = false
  }
  for (let split = 0; split <= text.length; split++)
    expect(accepts(text, split), `split ${split}`).toBe(valid)
})

it('agrees with JSON.parse for single-character mutations of nested data', () => {
  const original = '{"metadata":{"noCredentials":true},"data":[1.25e-3,null,"\\u0041"]}'
  for (let index = 0; index < original.length; index++) {
    for (const replacement of ['', '"', ',', '}', '0', '\\']) {
      const text = original.slice(0, index) + replacement + original.slice(index + 1)
      let valid = true
      try {
        JSON.parse(text)
      } catch {
        valid = false
      }
      expect(accepts(text, index), text).toBe(valid)
    }
  }
})

it.each([
  ['{"noCredentials":true}\n{"noCredentials":false}\n', true],
  [' \r\n{"a":true}\r\n\r\n{"b":false}\r\n', true],
  ['true\nfalse\nnull\n1\n"text"', true],
  ['{} {}', false],
  ['{}\n{"a":false,}', false],
  ['{}\n{\n"a":true\n}', false],
  ['{\n"a":true\n}\n{}', false],
  ['{}\r{}', false]
] as const)('requires complete newline-delimited JSON records: %j', (text, valid) => {
  for (let split = 0; split <= text.length; split++) expect(accepts(text, split)).toBe(valid)
})

it('does not retain large scalar values and fails closed at its nesting bound', () => {
  const syntax = new PackageJsonSyntax()
  syntax.write('{"data":"')
  for (let i = 0; i < 32; i++) syntax.write('a'.repeat(65536))
  syntax.write('","number":1')
  for (let i = 0; i < 32; i++) syntax.write('1'.repeat(65536))
  syntax.write(',"noCredentials":true}')
  expect(syntax.finish()).toBe(true)
  const deep = '['.repeat(1025) + '{"noCredentials":true}' + ']'.repeat(1025)
  expect(accepts(deep, 1025)).toBe(false)
})
