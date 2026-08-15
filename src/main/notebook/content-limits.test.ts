import { describe, expect, it } from 'vitest'

import {
  NOTEBOOK_CODE_LIMIT_BYTES,
  NOTEBOOK_FIGURE_COUNT_LIMIT,
  NOTEBOOK_FIGURE_LIMIT_BYTES,
  NOTEBOOK_TEXT_LIMIT_BYTES,
  assertNotebookCodeAppendWithinLimit,
  assertNotebookCodeWithinLimit,
  limitNotebookTerminalContent,
  limitUtf8
} from './content-limits'

describe('notebook content limits', () => {
  it('rejects code above 1 MiB without clipping executable source', () => {
    expect(() => assertNotebookCodeWithinLimit('x'.repeat(NOTEBOOK_CODE_LIMIT_BYTES))).not.toThrow()
    expect(() => assertNotebookCodeWithinLimit('x'.repeat(NOTEBOOK_CODE_LIMIT_BYTES + 1))).toThrow(
      /exceeds/u
    )
  })

  it('rejects a streamed append from separate UTF-8 byte lengths', () => {
    expect(() =>
      assertNotebookCodeAppendWithinLimit('x'.repeat(NOTEBOOK_CODE_LIMIT_BYTES - 4), '😀')
    ).not.toThrow()
    expect(() =>
      assertNotebookCodeAppendWithinLimit('x'.repeat(NOTEBOOK_CODE_LIMIT_BYTES - 3), '😀')
    ).toThrow(/exceeds/u)
  })

  it('clips UTF-8 only at a complete character boundary', () => {
    expect(limitUtf8('a😀b', 5)).toEqual({ text: 'a😀', truncated: true })
    expect(limitUtf8('�x', 3)).toEqual({ text: '�', truncated: true })
  })

  it('shares the 2 MiB text budget and marks the result truncated', () => {
    const result = limitNotebookTerminalContent({
      stdout: 'a'.repeat(NOTEBOOK_TEXT_LIMIT_BYTES - 1),
      stderr: 'bc',
      traceback: '',
      outputs: [
        { type: 'stream', name: 'stdout', text: 'ignored duplicate' },
        { type: 'stream', name: 'stderr', text: 'ignored duplicate' }
      ]
    })

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(
      NOTEBOOK_TEXT_LIMIT_BYTES
    )
    expect(result.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: result.stdout },
      { type: 'stream', name: 'stderr', text: result.stderr }
    ])
    expect(result.truncated).toBe(true)
  })

  it('keeps at most 12 figures and rejects an oversized figure', () => {
    const small = Buffer.from('image').toString('base64')
    const oversized = Buffer.alloc(NOTEBOOK_FIGURE_LIMIT_BYTES + 1).toString('base64')
    const outputs = Array.from({ length: NOTEBOOK_FIGURE_COUNT_LIMIT + 1 }, (_, index) => ({
      type: 'display' as const,
      data: { [`image/png;index=${index}`]: small }
    }))
    outputs.push({ type: 'display', data: { 'image/png': oversized } })

    const result = limitNotebookTerminalContent({
      stdout: '',
      stderr: '',
      traceback: '',
      outputs
    })

    expect(
      result.outputs.reduce(
        (count, output) =>
          count + (output.type === 'display' ? Object.keys(output.data).length : 0),
        0
      )
    ).toBe(NOTEBOOK_FIGURE_COUNT_LIMIT)
    expect(result.truncated).toBe(true)
  })
})
