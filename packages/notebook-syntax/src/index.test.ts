import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withParsedNotebookSource } from './index'

describe('packaged grammars', () => {
  it.each([
    ['python', 'value = 1'],
    ['r', 'value <- 1'],
    ['bash', 'echo hello'],
    ['javascript', 'globalThis.value = 1']
  ] as const)('loads %s independently of the host', async (language, source) => {
    expect(await withParsedNotebookSource(language, source, (root) => root.text)).toEqual({
      state: 'ok',
      value: source
    })
  })
  it('verifies the pinned JavaScript grammar checksum', async () => {
    const root = join(__dirname, '../assets')
    const provenance = JSON.parse(
      await readFile(join(root, 'tree-sitter-javascript.provenance.json'), 'utf8')
    )
    expect(
      createHash('sha256')
        .update(await readFile(join(root, 'tree-sitter-javascript.wasm')))
        .digest('hex')
    ).toBe(provenance.wasmSha256)
  })
  it('reports malformed source without retaining a parser', async () => {
    expect(await withParsedNotebookSource('python', 'if:', () => true)).toEqual({
      state: 'error',
      reason: 'parse-error'
    })
    expect(await withParsedNotebookSource('python', 'x = 1', () => true)).toEqual({
      state: 'ok',
      value: true
    })
  })
})
