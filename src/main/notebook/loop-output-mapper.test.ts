import { describe, it, expect } from 'vitest'
import { mapLoopOutputs } from './loop-output-mapper'

describe('mapLoopOutputs', () => {
  it('maps stdout/stderr to stream outputs and returns accumulated text', () => {
    const result = mapLoopOutputs({
      stdout: 'hello\n',
      stderr: 'warn\n',
      error: null,
      result: null,
      figures: []
    })
    expect(result.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'hello\n' },
      { type: 'stream', name: 'stderr', text: 'warn\n' }
    ])
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('warn\n')
    expect(result.traceback).toBe('')
  })

  it('maps one image/png figure to a display bundle', () => {
    const result = mapLoopOutputs({
      stdout: '',
      stderr: '',
      error: null,
      result: null,
      figures: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }]
    })
    expect(result.outputs).toEqual([{ type: 'display', data: { 'image/png': 'iVBORw0KGgo=' } }])
  })

  it('maps a non-empty result to a text/plain display bundle', () => {
    const result = mapLoopOutputs({
      stdout: '',
      stderr: '',
      error: null,
      result: '42',
      figures: []
    })
    expect(result.outputs).toEqual([{ type: 'display', data: { 'text/plain': '42' } }])
  })

  it('maps a multi-line error to an error output with first-line message and full traceback', () => {
    const error = 'Traceback (most recent call last):\nValueError: boom'
    const result = mapLoopOutputs({
      stdout: '',
      stderr: '',
      error,
      result: null,
      figures: []
    })
    expect(result.outputs).toEqual([
      {
        type: 'error',
        message: 'Traceback (most recent call last):',
        traceback: error
      }
    ])
    expect(result.traceback).toBe(error)
  })

  it('attaches the source line to the error output when the loop reports one', () => {
    const result = mapLoopOutputs({
      stdout: '',
      stderr: '',
      error: "there is no package called 'ggrepel'",
      errorLine: 7,
      result: null,
      figures: []
    })
    expect(result.outputs).toEqual([
      {
        type: 'error',
        message: "there is no package called 'ggrepel'",
        traceback: "there is no package called 'ggrepel'",
        line: 7
      }
    ])
  })

  it('returns empty outputs and empty text fields when everything is empty', () => {
    const result = mapLoopOutputs({
      stdout: '',
      stderr: '',
      error: null,
      result: null,
      figures: []
    })
    expect(result.outputs).toEqual([])
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.traceback).toBe('')
  })

  it('orders outputs as stream(stdout), stream(stderr), figures, result-display, error', () => {
    const error = 'RuntimeError: bad\ndetail line'
    const result = mapLoopOutputs({
      stdout: 'out\n',
      stderr: 'err\n',
      error,
      result: '7',
      figures: [
        { mime: 'image/png', base64: 'AAA=' },
        { mime: 'image/svg+xml', base64: 'BBB=' }
      ]
    })
    expect(result.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'out\n' },
      { type: 'stream', name: 'stderr', text: 'err\n' },
      { type: 'display', data: { 'image/png': 'AAA=' } },
      { type: 'display', data: { 'image/svg+xml': 'BBB=' } },
      { type: 'display', data: { 'text/plain': '7' } },
      { type: 'error', message: 'RuntimeError: bad', traceback: error }
    ])
  })
})
