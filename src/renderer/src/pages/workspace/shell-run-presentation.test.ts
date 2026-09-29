import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { identityTranslate } from './workspace-translate-clause'
import {
  shellFailureMetaLabel,
  shellRunFailureLabel,
  shellRunOutcomeNotice
} from './shell-run-presentation'

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'shell-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'bash',
  script: 'exit 7',
  status: 'failed',
  startedAt: 0,
  text: { stdout: '', stderr: 'diagnostic', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  ...overrides
})

describe('Shell Run presentation', () => {
  it.each(['shell-runtime-unavailable', 'shell-start-failed'] as const)(
    'identifies confirmed %s as not executed',
    (shellErrorCode) => {
      const result = run({ shellErrorCode, exitCode: null })
      expect(shellRunFailureLabel(result)).toBe('Shell did not start')
      expect(shellRunOutcomeNotice(result, identityTranslate)).toContain('command was not run')
    }
  )

  it('uses the actual nonzero exit code while retaining stderr as independent output', () => {
    const result = run({ shellErrorCode: 'shell-nonzero-exit', exitCode: 7 })
    expect(shellRunFailureLabel(result)).toBe('Command failed')
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBe(
      'The Shell command exited with code 7.'
    )
  })

  it('does not present a blocked synthetic exit code as a command failure', () => {
    const result = run({ shellErrorCode: 'shell-command-blocked', exitCode: 1 })
    expect(shellRunFailureLabel(result)).toBe('Shell did not start')
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBe(
      'The Shell command was blocked before execution.'
    )
    expect(
      shellFailureMetaLabel(
        { status: 'failed', errorCode: 'shell-command-blocked', exitCode: 1 },
        identityTranslate
      )
    ).toBe('Shell did not start')
  })

  it('keeps a known network preflight failure in the not-run category', () => {
    const result = run({ shellErrorCode: 'shell-network-transport-unsupported', exitCode: null })
    expect(shellRunFailureLabel(result)).toBe('Shell did not start')
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBe(
      'The Shell process did not start. The command was not run.'
    )
  })

  it('does not infer a launch failure from a historical failed Run without execution facts', () => {
    const result = run({ exitCode: null })
    expect(shellRunFailureLabel(result)).toBe('Shell execution failed')
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBe(
      'Shell execution failed. Check the output for details.'
    )
  })

  it('keeps an unverified cleanup restriction ahead of a generic failure explanation', () => {
    const result = run({
      shellErrorCode: 'shell-cleanup-incomplete',
      recovery: { execution: 'may-have-run', retryAfter: 'cleanup-verified' }
    })
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBe(
      'Shell cleanup could not be verified. Do not retry until cleanup is verified; check for partial effects.'
    )
  })

  it('uses the same facts for a compact tool-row label', () => {
    expect(
      shellFailureMetaLabel(
        { status: 'failed', errorCode: 'shell-nonzero-exit', exitCode: 7 },
        identityTranslate
      )
    ).toBe('Command failed (exit 7)')
    expect(
      shellFailureMetaLabel(
        { status: 'failed', errorCode: 'shell-start-failed', exitCode: null },
        identityTranslate
      )
    ).toBe('Shell did not start')
  })

  it('does not mark exit-zero stderr as a failure', () => {
    const result = run({ status: 'completed', exitCode: 0 })
    expect(shellRunFailureLabel(result)).toBeUndefined()
    expect(shellRunOutcomeNotice(result, identityTranslate)).toBeUndefined()
  })
})
