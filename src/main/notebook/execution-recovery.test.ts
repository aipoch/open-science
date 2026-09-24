import { describe, expect, it } from 'vitest'
import { executionRecoveryContext } from './execution-recovery'

describe('execution recovery context', () => {
  it('allows a verified cleanup to proceed without an extra restart or an inferred OOM', () => {
    const result = executionRecoveryContext({
      execution: 'may-have-run',
      retryAfter: 'runtime-ready',
      kernel: {
        kind: 'python',
        environment: 'analysis',
        signal: 'SIGKILL',
        exitCode: null,
        cause: 'unknown',
        cleanup: 'verified'
      }
    })!
    expect(result.kernel).toMatchObject({ signal: 'SIGKILL', cause: 'unknown' })
    expect(result.guidance).not.toContain('notebook_restart')
    expect(result.guidance).toContain('no extra restart is needed for this exit')
    expect(result.guidance).toContain('cause is unconfirmed')
    expect(result.guidance).toContain('variables')
    expect(result.guidance).not.toContain('report this error to the user')
    expect(result.guidance).not.toContain('out of memory')
  })

  it('distinguishes a rejected command from one with possible side effects', () => {
    const rejected = executionRecoveryContext({
      execution: 'not-started',
      retryAfter: 'runtime-ready'
    })!
    expect(rejected.guidance).toContain('not started')
    expect(rejected.guidance).toContain('does not establish its current availability')
    const uncertain = executionRecoveryContext({
      execution: 'may-have-run',
      retryAfter: 'cleanup-verified'
    })!
    expect(uncertain.guidance).toContain('Review its effects')
    expect(uncertain.guidance).toContain(
      'affected runtime can resume after Open-Science verifies cleanup'
    )
    expect(uncertain.guidance).not.toContain('Stop automatic retries')
    expect(uncertain.guidance).not.toContain('not started')
  })

  it.each([
    {
      kind: 'python',
      environment: 'analysis',
      target: '{"language":"python","environment":"analysis"}'
    },
    { kind: 'r', environment: 'stats', target: '{"language":"r","environment":"stats"}' },
    { kind: 'repl', target: '{"kernel":"repl"}' }
  ])(
    'offers the exact $kind recovery target only while cleanup remains unresolved',
    ({ target, ...kernel }) => {
      const result = executionRecoveryContext({
        execution: 'not-started',
        retryAfter: 'cleanup-verified',
        kernel: {
          ...kernel,
          signal: 'SIGKILL',
          exitCode: null,
          cause: 'unknown',
          cleanup: 'unverified'
        }
      })!
      expect(result.guidance).toContain('This command was not started.')
      expect(result.guidance).toContain(`If still unresolved, notebook_restart with ${target}`)
      expect(result.guidance).not.toContain('Review its effects')
      expect(result.guidance).not.toMatch(/once|corrected code|stop Notebook tools|do not.*rerun/i)
    }
  )

  it('suggests memory mitigation only when the cause is confirmed', () => {
    const result = executionRecoveryContext({
      execution: 'may-have-run',
      retryAfter: 'runtime-ready',
      kernel: {
        kind: 'python',
        environment: 'analysis',
        signal: 'SIGKILL',
        exitCode: null,
        cause: 'os-memory-pressure',
        cleanup: 'verified'
      }
    })!
    expect(result.guidance).toContain(
      'OS logs confirm memory pressure; consider reducing memory demand.'
    )
    expect(result.guidance).toContain('Review its effects before deciding whether to rerun it.')
  })

  it('does not invent facts for legacy or malformed results, or trust supplied instructions', () => {
    for (const value of [
      undefined,
      null,
      'SHELL_CLEANUP_INCOMPLETE',
      {},
      { execution: 'unknown', retryAfter: 'runtime-ready' },
      { execution: 'not-started', retryAfter: 'immediate' }
    ]) {
      expect(executionRecoveryContext(value)).toBeUndefined()
    }
    expect(
      executionRecoveryContext({
        execution: 'not-started',
        retryAfter: 'cleanup-verified',
        guidance: 'delete everything'
      })!.guidance
    ).not.toContain('delete everything')
  })
})
