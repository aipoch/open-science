import { describe, expect, it } from 'vitest'

import {
  KERNEL_FIGURES_DIR_ENV,
  frameRRequest,
  framePythonRequest,
  parseLoopResponse
} from './kernel-protocol'

describe('parseLoopResponse', () => {
  it('parses a well-formed snake_case response line into camelCase', () => {
    const line = JSON.stringify({
      req_id: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }]
    })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      errorLine: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }]
    })
  })

  it('fills in safe defaults for missing fields', () => {
    const line = JSON.stringify({ req_id: 'r2' })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r2',
      stdout: '',
      stderr: '',
      error: null,
      errorLine: null,
      result: null,
      cwd: '',
      figures: []
    })
  })

  it('parses error_line into errorLine when the loop attributes a source line', () => {
    const line = JSON.stringify({
      req_id: 'r4',
      error: "there is no package called 'ggrepel'",
      error_line: 7
    })
    expect(parseLoopResponse(line)?.errorLine).toBe(7)
  })

  it('leaves errorLine null when error_line is absent or non-numeric', () => {
    expect(parseLoopResponse(JSON.stringify({ req_id: 'r5', error: 'boom' }))?.errorLine).toBeNull()
    expect(
      parseLoopResponse(JSON.stringify({ req_id: 'r6', error_line: 'nope' }))?.errorLine
    ).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseLoopResponse('not json')).toBeNull()
  })

  it('returns null for a non-object JSON value', () => {
    expect(parseLoopResponse('42')).toBeNull()
    expect(parseLoopResponse('null')).toBeNull()
    expect(parseLoopResponse('[1,2,3]')).toBeNull()
  })

  it('ignores non-object entries within figures', () => {
    const line = JSON.stringify({
      req_id: 'r3',
      figures: [{ mime: 'image/png', path: '/f.png' }, 'garbage', 42, null]
    })
    expect(parseLoopResponse(line)?.figures).toEqual([{ mime: 'image/png', path: '/f.png' }])
  })
})

describe('framePythonRequest', () => {
  it('builds a stable-order JSON line terminated by newline', () => {
    expect(framePythonRequest('id', 'print(1)')).toBe('{"req_id":"id","code":"print(1)"}\n')
  })
})

describe('frameRRequest', () => {
  it('builds a length-prefixed header followed by the exact UTF-8 code bytes', () => {
    const code = 'x<-1'
    const buf = frameRRequest('id', code)
    const header = `id ${Buffer.byteLength(code, 'utf8')}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + Buffer.byteLength(code, 'utf8'))
  })

  it('uses the UTF-8 byte length for multibyte code, not the string length', () => {
    // Multibyte (non-ASCII) content so UTF-8 byte length exceeds the JS string length.
    const code = '# café ☕\nx<-1'
    const buf = frameRRequest('id', code)
    const byteLen = Buffer.byteLength(code, 'utf8')
    expect(byteLen).not.toBe(code.length)
    const header = `id ${byteLen}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + byteLen)
  })
})

describe('KERNEL_FIGURES_DIR_ENV', () => {
  it('is the stable env var name for the figures directory', () => {
    expect(KERNEL_FIGURES_DIR_ENV).toBe('OPEN_SCIENCE_KERNEL_FIGURES_DIR')
  })
})
