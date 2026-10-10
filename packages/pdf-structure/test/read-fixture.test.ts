import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const directories: string[] = []
const fixtureFile = (text: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'pdf-fixture-'))
  directories.push(directory)
  const path = join(directory, 'fixture.jsonl')
  writeFileSync(path, text)
  return path
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('restores nested containers, source records and exact text without sharing mutable state', () => {
  const path = fixtureFile(
    [
      '[[],{}]',
      '[["table"],{}]',
      '[["table","grid"],[]]',
      '[["table","grid",0],["0","0 (0)","µg\\nvalue"]]',
      '[["tokens"],[]]',
      '[["tokens",0],{"text":"−0.21","rect":[0,1.25,2,3]}]',
      '[["empty"],[]]',
      '[["absent"],null]'
    ].join('\r\n') + '\r\n'
  )
  const source = {
    table: { grid: [['0', '0 (0)', 'µg\nvalue']] },
    tokens: [{ text: '−0.21', rect: [0, 1.25, 2, 3] }],
    empty: [],
    absent: null
  }
  const first = readPdfFixture(path)
  expect(first).toEqual(source)
  first.table.grid[0][0] = 'changed'
  expect(readPdfFixture(path)).toEqual(source)
})

it('rejects a missing root record', () => {
  expect(() => readPdfFixture(fixtureFile('[["tokens"],[]]\n'))).toThrow('Missing fixture root')
})
