import { expect, it } from 'vitest'
import { projectDiagnosticNotebook } from './notebook'

it('keeps failure/recovery evidence while excluding unrequested code and research content', () => {
  const result = projectDiagnosticNotebook(
    {
      projectId: 'p',
      sessionId: 's',
      workspaceCwd: 'PRIVATE',
      kernel: { pythonPath: 'PRIVATE' },
      runs: [
        {
          runId: 'run-1',
          status: 'failed',
          script: 'PRIVATE',
          frozenShellContext: { environment: { TOKEN: 'PRIVATE' } },
          text: { stderr: 'password=PRIVATE', stdout: 'PRIVATE' },
          outputs: [
            { type: 'error', message: 'ValueError: password=PRIVATE' },
            { type: 'display', data: 'PRIVATE' }
          ],
          recovery: { execution: 'may-have-run', retryAfter: 'cleanup-verified' }
        }
      ]
    },
    { projectId: 'p', sessionId: 's' }
  )
  expect(result).toHaveProperty('runs.0.status', 'failed')
  expect(result).toHaveProperty('runs.0.recovery.retryAfter', 'cleanup-verified')
  expect(result).toHaveProperty('runs.0.errorOutputs.0.message', 'ValueError: password=[redacted]')
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  expect(result).not.toHaveProperty('executionCodeCoverage')
})

it('rejects a misplaced document and counts omitted historical runs', () => {
  expect(() =>
    projectDiagnosticNotebook(
      { projectId: 'other', sessionId: 's', runs: [] },
      { projectId: 'p', sessionId: 's' }
    )
  ).toThrow('ownership')
  const runs = Array.from({ length: 252 }, (_, index) => ({
    runId: `r-${index}`,
    status: 'completed'
  }))
  const result = projectDiagnosticNotebook(
    { projectId: 'p', sessionId: 's', runs },
    { projectId: 'p', sessionId: 's' }
  )
  expect(result.runCounts).toEqual({ source: 252, retained: 100, omitted: 152 })
  expect((result.runs as Record<string, unknown>[])[0].runId).toBe('r-152')
})

it('redacts token-shaped values even in short accepted run and recovery fields', () => {
  const token = 'sk-abcdefghijk'
  const awsKey = 'AKIA1234567890123456'
  const result = projectDiagnosticNotebook(
    {
      projectId: 'p',
      sessionId: 's',
      kernel: { terminatedKernelInstances: [{ kind: 'python', environment: token }] },
      runs: [
        {
          runId: token,
          status: token,
          kernelKind: token,
          source: token,
          inputKind: token,
          executionMode: token,
          interruptionReason: token,
          shellErrorCode: token,
          shellRuntimeStatus: token,
          recovery: {
            kernel: {
              kind: token,
              cause: token,
              cleanup: token,
              environment: token,
              signal: awsKey
            }
          }
        }
      ]
    },
    { projectId: 'p', sessionId: 's' }
  )
  const exported = JSON.stringify(result)
  expect(exported).not.toContain(token)
  expect(exported).not.toContain(awsKey)
  expect(exported).toContain('[redacted]')
})

it.each([2_000, 20_000])(
  'retains the beginning and final cause of a %i-character error within its budget',
  (length) => {
    const detail =
      'Traceback start\npassword=PRIVATE\n' +
      'x'.repeat(length) +
      '\npassword=PRIVATE\nValueError: final cause'
    const result = projectDiagnosticNotebook(
      {
        projectId: 'p',
        sessionId: 's',
        runs: [
          {
            text: { stderr: detail, traceback: detail },
            outputs: [{ type: 'error', message: detail, traceback: detail }]
          }
        ]
      },
      { projectId: 'p', sessionId: 's' }
    )
    const run = (result.runs as Record<string, unknown>[])[0]
    const text = run.text as Record<string, string>
    const output = (run.errorOutputs as Record<string, string>[])[0]
    for (const field of [text.stderr, text.traceback, output.message, output.traceback]) {
      expect(field).toContain('Traceback start\npassword=[redacted]')
      expect(field).toContain('ValueError: final cause')
      expect(field).not.toContain('PRIVATE')
      if (length > 16_000) {
        expect(field.length).toBe(16_000)
        expect(field).toContain('…[middle truncated]')
      } else expect(field).toBe(detail.replaceAll('PRIVATE', '[redacted]'))
    }
    expect(result.truncation).toMatchObject({ truncatedTextFields: length > 16_000 ? 4 : 0 })
  }
)

it('includes usable credential-redacted code only on opt-in and reports each retained run', () => {
  const script = 'api_key = "sk-abcdefghijk"\npath = "/private/work/data.csv"\nratio = 10 / 2\n'
  const result = projectDiagnosticNotebook(
    {
      projectId: 'p',
      sessionId: 's',
      runs: [
        { runId: 'normal', script },
        { runId: 'empty', script: '' },
        { runId: 'missing' },
        { runId: 'long', script: 'x'.repeat(16_100) }
      ]
    },
    { projectId: 'p', sessionId: 's' },
    { dataRoot: '/private/work' },
    true
  )
  const runs = result.runs as Record<string, unknown>[]
  expect(runs[0]).toMatchObject({ runId: 'normal', scriptStatus: 'included' })
  expect(runs[0].script).toContain('path = "/private/work/data.csv"\nratio = 10 / 2\n')
  expect(runs[0].script).not.toContain('sk-abcdefghijk')
  expect(runs[1]).toMatchObject({ runId: 'empty', script: '', scriptStatus: 'included' })
  expect(runs[2]).toMatchObject({ runId: 'missing', scriptStatus: 'missing' })
  expect(runs[2]).not.toHaveProperty('script')
  expect(runs[3]).toMatchObject({ runId: 'long', scriptStatus: 'truncated' })
  expect((runs[3].script as string).length).toBe(16_000)
  expect(runs[3].script).toMatch(/\n…\[execution code truncated\]$/)
  expect(result.executionCodeCoverage).toEqual({ included: 2, missing: 1, truncated: 1 })
  expect(result.truncation).toMatchObject({ truncatedTextFields: 0 })
})
