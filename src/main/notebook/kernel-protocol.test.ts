import { describe, expect, it } from 'vitest'

import {
  KERNEL_FIGURES_DIR_ENV,
  frameRNamespaceRequest,
  frameRRequest,
  framePythonNamespaceRequest,
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
      interrupt_ack: true,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environment: {
        runtime_version: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            version_status: 'known',
            ecosystem: 'python',
            evidence_sources: ['python-kernel-modules'],
            loaded_state: 'loaded'
          }
        ]
      }
    })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      interruptAck: true,
      errorLine: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environmentOverlay: {
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-kernel-modules'],
            loadedState: 'loaded'
          }
        ]
      }
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

  it('parses bounded namespace fields and locale-independent R text', () => {
    const encode = (value: string): string => Buffer.from(value).toString('base64')
    const response = parseLoopResponse(
      JSON.stringify({
        req_id: 'namespace-1',
        namespace: {
          variable_count: 2,
          variables_truncated: true,
          variables: [
            {
              name: 'x',
              type: 'builtins.int',
              size_bytes: 28,
              shape: '1 item',
              preview: '42'
            },
            {
              name_base64: encode('图形'),
              type_base64: encode('Figure'),
              preview_base64: encode('活跃变量'),
              preview_truncated: true,
              is_private: true
            }
          ]
        }
      })
    )

    expect(response?.namespace).toEqual({
      variableCount: 2,
      variablesTruncated: true,
      variables: [
        {
          name: 'x',
          type: 'builtins.int',
          sizeBytes: 28,
          shape: '1 item',
          preview: '42'
        },
        {
          name: '图形',
          type: 'Figure',
          preview: '活跃变量',
          previewTruncated: true,
          private: true
        }
      ]
    })
  })
})

describe('framePythonRequest', () => {
  it('builds a stable-order JSON line terminated by newline', () => {
    expect(framePythonRequest('id', 'print(1)')).toBe('{"req_id":"id","code":"print(1)"}\n')
    expect(framePythonRequest('id', 'print(1)', undefined, ['/registered/generation-1'])).toBe(
      '{"req_id":"id","code":"print(1)","protected_dirs":["/registered/generation-1"]}\n'
    )
  })

  it('builds a distinct namespace operation without executable source', () => {
    expect(framePythonNamespaceRequest('id', true)).toBe(
      '{"req_id":"id","operation":"inspect_namespace","include_private":true}\n'
    )
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

  it('marks namespace inspection in the R frame header', () => {
    expect(frameRNamespaceRequest('id', false).toString('utf8')).toBe('id 0 inspect_namespace\n')
    expect(frameRNamespaceRequest('id', true).toString('utf8')).toBe(
      'id 7 inspect_namespace\nprivate'
    )
  })
})

describe('KERNEL_FIGURES_DIR_ENV', () => {
  it('is the stable env var name for the figures directory', () => {
    expect(KERNEL_FIGURES_DIR_ENV).toBe('OPEN_SCIENCE_KERNEL_FIGURES_DIR')
  })
})
