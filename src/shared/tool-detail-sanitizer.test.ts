import { describe, expect, it, vi } from 'vitest'

import * as redaction from './diagnostic-redaction'

import {
  capToolDetailText,
  sanitizeRawToolPayload,
  sanitizeNotebookCodeReviewPayload,
  sanitizeToolContent,
  sanitizeToolDetailText
} from './tool-detail-sanitizer'

describe('capToolDetailText', () => {
  it('preserves bounded text and truncates oversized text at the shared limit', () => {
    const bounded = 'x'.repeat(16_000)

    expect(capToolDetailText(bounded)).toBe(bounded)
    expect(capToolDetailText(`${bounded}tail`)).toBe(`${bounded}\n…`)
  })

  it('caps text again after redaction markers expand the result', () => {
    const result = sanitizeToolDetailText('token=x;'.repeat(2_000))

    expect(result).toHaveLength(16_002)
    expect(result).toMatch(/\n…$/)
    expect(result).not.toContain('token=x')
  })
})

describe('sanitizeRawToolPayload', () => {
  it('uses the shared credential-key policy without redacting token metrics', () => {
    expect(
      sanitizeRawToolPayload(
        {
          auth: 'test-auth-value',
          privateKey: 'test-private-key-value',
          pat: 'test-pat-value',
          inputTokenCount: 42
        },
        8_000
      )
    ).toEqual({
      auth: '[redacted]',
      privateKey: '[redacted]',
      pat: '[redacted]',
      inputTokenCount: 42
    })
  })

  it('redacts signed URLs whose separators are JSON-escaped', () => {
    const result = sanitizeRawToolPayload(
      {
        command:
          'curl "https:\\/\\/storage.example.test/private?sig=test-escaped-signature&version=7"'
      },
      8_000
    )

    expect(JSON.stringify(result)).not.toContain('test-escaped-signature')
    expect(JSON.stringify(result)).toContain('[redacted]')
  })
})

describe('sanitizeToolContent', () => {
  it('keeps only supported content projections and strips unknown fields', () => {
    expect(
      sanitizeToolContent([
        null,
        { type: 'content', content: { type: 'text', text: 'result', secret: 'drop-me' } },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'file:///report.csv',
            name: 'report.csv',
            title: 'Report',
            description: 'drop-me'
          }
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///notes.txt', text: 'notes', blob: 'drop-me' }
          }
        },
        { type: 'content', content: { type: 'image', data: 'drop-me' } }
      ])
    ).toEqual([
      { type: 'content', content: { type: 'text', text: 'result' } },
      {
        type: 'content',
        content: {
          type: 'resource_link',
          uri: 'file:///report.csv',
          name: 'report.csv',
          title: 'Report'
        }
      },
      {
        type: 'content',
        content: { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'notes' } }
      }
    ])
  })

  it('preserves non-sensitive resource URI fragments', () => {
    const uri = 'https://example.test/report#methods'

    expect(
      sanitizeToolContent([{ type: 'content', content: { type: 'resource_link', uri } }])
    ).toEqual([{ type: 'content', content: { type: 'resource_link', uri } }])
  })

  it('normalizes diffs and caps each text field independently', () => {
    const oversized = 'x'.repeat(16_001)

    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/new.ts', newText: 42 },
        { type: 'diff', path: '', oldText: 'ignored', newText: 'ignored' }
      ])
    ).toEqual([{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: '' }])
    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/old.ts', oldText: oversized, newText: 'replacement' }
      ])
    ).toEqual([
      {
        type: 'diff',
        path: '/repo/old.ts',
        oldText: `${'x'.repeat(16_000)}\n…`,
        newText: 'replacement'
      }
    ])
    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/new.ts', oldText: 'original', newText: oversized }
      ])
    ).toEqual([
      {
        type: 'diff',
        path: '/repo/new.ts',
        oldText: 'original',
        newText: `${'x'.repeat(16_000)}\n…`
      }
    ])
  })

  it('drops malformed or empty projections', () => {
    expect(sanitizeToolContent(undefined)).toBeUndefined()
    expect(
      sanitizeToolContent([
        'text',
        { type: 'content', content: { type: 'text', text: '' } },
        { type: 'content', content: { type: 'resource_link', uri: '' } },
        { type: 'content', content: { type: 'resource', resource: {} } },
        { type: 'terminal', terminalId: 'terminal-1' }
      ])
    ).toBeUndefined()
  })

  it('stops before an entry that would exceed the aggregate content budget', () => {
    const result = sanitizeToolContent([
      { type: 'content', content: { type: 'text', text: 'a'.repeat(16_000) } },
      { type: 'content', content: { type: 'text', text: 'b'.repeat(16_000) } },
      { type: 'content', content: { type: 'text', text: 'after-budget' } }
    ])

    expect(result).toEqual([
      { type: 'content', content: { type: 'text', text: 'a'.repeat(16_000) } }
    ])
  })
})

describe('bounded Notebook code review evidence', () => {
  const payload = (
    code: string
  ): {
    code: string
    notebookCodeRisk: {
      language: string
      runId: string
      cwd: string
      risks: Array<{ operation: string; source: string; line: number }>
    }
  } => ({
    code,
    notebookCodeRisk: {
      language: 'python',
      runId: 'run-1',
      cwd: '/private/internal',
      risks: [{ operation: 'os.unlink', source: 'os.unlink(path)', line: 1 }]
    }
  })
  it.each(['bash', 'python'])('retains only valid shell display evidence for %s', (language) => {
    const value = payload('Remove-Item ./temporary.txt')
    const output = sanitizeNotebookCodeReviewPayload({
      ...value,
      notebookCodeRisk: {
        ...value.notebookCodeRisk,
        language,
        shellRuntime: { kind: 'powershell', interpreterPath: '/internal/pwsh', token: 'secret' }
      }
    }) as { notebookCodeRisk: { shellRuntime?: unknown } }
    expect(output.notebookCodeRisk.shellRuntime).toEqual(
      language === 'bash' ? { kind: 'powershell' } : undefined
    )
    expect(sanitizeNotebookCodeReviewPayload(output)).toEqual(output)
  })
  it.each(['x'.repeat(10_000), '\u0000'.repeat(1024 * 1024)])(
    'preserves accepted long source even when JSON escaping expands it',
    (code) => {
      expect(sanitizeNotebookCodeReviewPayload(payload(code))).toMatchObject({
        code,
        notebookCodeRisk: { riskCount: 1 }
      })
      expect(sanitizeRawToolPayload(payload(code), 8_000)).toBeUndefined()
    }
  )
  it('bounds findings independently, preserves total and drops internal paths', () => {
    const value = payload('os.unlink(path)')
    value.notebookCodeRisk.risks = Array.from({ length: 500 }, (_, i) => ({
      operation: 'os.unlink',
      source: 'x'.repeat(2000),
      line: i + 1
    }))
    const output = sanitizeNotebookCodeReviewPayload(value) as typeof value & {
      notebookCodeRisk: { riskCount: number }
    }
    expect(output.notebookCodeRisk.risks).toHaveLength(128)
    expect(output.notebookCodeRisk.riskCount).toBe(500)
    expect(output.notebookCodeRisk.risks[0].source).toHaveLength(1024)
    expect(output.notebookCodeRisk).not.toHaveProperty('cwd')
    expect(sanitizeNotebookCodeReviewPayload(output)).toEqual(output)
  })
  it('redacts credentials and rejects malformed or oversized executable evidence', () => {
    expect(
      JSON.stringify(sanitizeNotebookCodeReviewPayload(payload('token=secret-value')))
    ).not.toContain('secret-value')
    for (const value of [
      payload('x'.repeat(1024 * 1024 + 1)),
      { code: 'x', notebookCodeRisk: { language: 'python', risks: [] } },
      {
        code: 'x',
        notebookCodeRisk: { language: 'invalid', risks: [{ operation: 'x', source: 'x', line: 1 }] }
      },
      {
        code: 'x',
        notebookCodeRisk: { language: 'python', risks: [{ operation: 'x', source: 'x', line: 0 }] }
      }
    ])
      expect(sanitizeNotebookCodeReviewPayload(value)).toBeUndefined()
  })
})

describe('bounded reuse of long unchanged tool text', () => {
  it('reuses exact clean text while rechecking modified input and credentials', () => {
    const redact = vi.spyOn(redaction, 'redactSensitiveText')
    try {
      const code = '# unchanged long review\n'.repeat(1000)
      const input = { code }
      const first = sanitizeRawToolPayload(input, 8 * 1024 * 1024)
      const second = sanitizeRawToolPayload(input, 8 * 1024 * 1024)
      expect(first).toEqual({ code })
      expect(second).toEqual(first)
      expect(second).not.toBe(first)
      expect(redact).toHaveBeenCalledTimes(1)
      expect(sanitizeRawToolPayload({ password: code }, 8 * 1024 * 1024)).toEqual({
        password: '[redacted]'
      })
      input.code += '\npassword="cache-test-secret"'
      for (let i = 0; i < 2; i++) {
        expect(JSON.stringify(sanitizeRawToolPayload(input, 8 * 1024 * 1024))).not.toContain(
          'cache-test-secret'
        )
      }
      expect(redact).toHaveBeenCalledTimes(3)
    } finally {
      redact.mockRestore()
    }
  })

  it.each([
    ['entries', 65, 16_000],
    ['characters', 20, 900_000]
  ] as const)('evicts old results at the %s bound', (_bound, count, length) => {
    const redact = vi.spyOn(redaction, 'redactSensitiveText')
    try {
      const text = (index: number): string => `# capacity ${_bound} ${index}\n` + '.'.repeat(length)
      for (let i = 0; i < count; i++) sanitizeRawToolPayload({ code: text(i) }, 8 * 1024 * 1024)
      redact.mockClear()
      sanitizeRawToolPayload({ code: text(count - 1) }, 8 * 1024 * 1024)
      expect(redact).not.toHaveBeenCalled()
      sanitizeRawToolPayload({ code: text(0) }, 8 * 1024 * 1024)
      expect(redact).toHaveBeenCalledTimes(1)
    } finally {
      redact.mockRestore()
    }
  })
})
