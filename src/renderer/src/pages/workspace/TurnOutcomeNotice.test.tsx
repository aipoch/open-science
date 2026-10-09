// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TurnOutcome } from '../../../../shared/session-persistence'
import { TurnOutcomeNotice, type TurnOutcomeActions } from './TurnOutcomeNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('turn outcome notice action ownership', () => {
  let container: HTMLDivElement
  let root: Root
  let actions: TurnOutcomeActions

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    actions = {
      artifactRetryDisabled: false,
      onRetryArtifact: vi.fn(),
      onReportError: vi.fn(),
      resolveError: (error) => error?.trim() || 'The run failed with no error message.'
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (
    outcome: Exclude<TurnOutcome, { kind: 'completed' }>,
    promptMessageId = 'historical-prompt'
  ): void => {
    act(() =>
      root.render(
        <TurnOutcomeNotice outcome={outcome} promptMessageId={promptMessageId} actions={actions} />
      )
    )
  }

  it('reports the clicked failed turn even when another failure is current', () => {
    render({
      kind: 'failed',
      settledAt: 1,
      error: 'Historical opaque error',
      errorReportable: true
    })
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Report this error"]')?.click()
    )
    expect(actions.onReportError).toHaveBeenCalledExactlyOnceWith('Historical opaque error')
  })

  it('uses each outcome reportability without borrowing the current turn flag', () => {
    render({ kind: 'failed', settledAt: 1, error: 'Provider diagnostic', errorReportable: false })
    expect(container.querySelector('[aria-label="Report this error"]')).toBeNull()
    render({ kind: 'failed', settledAt: 1, error: 'Opaque older failure', errorReportable: true })
    expect(container.querySelector('[aria-label="Report this error"]')).not.toBeNull()
  })

  it('captures the failed prompt for native Artifact publication retry', () => {
    render({
      kind: 'failed',
      settledAt: 1,
      error: 'Detailed native finalization failure',
      recovery: 'retry-artifact-publication'
    })
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Retry Artifact publication"]')
        ?.click()
    )
    expect(actions.onRetryArtifact).toHaveBeenCalledExactlyOnceWith('historical-prompt')
  })

  it.each(['interrupted', 'cancelled'] as const)(
    'leaves %s recovery presentation to the Session',
    (kind) => {
      render(
        kind === 'cancelled'
          ? { kind, settledAt: 1, recovery: 'resume' }
          : { kind, settledAt: 1, cause: 'app-restart', recovery: 'resume' }
      )
      expect(container.textContent).toBe('')
      expect(container.querySelector('[data-slot="turn-outcome-notice"]')).toBeNull()
      expect(container.querySelector('[aria-label="Resume session"]')).toBeNull()
    }
  )

  it('keeps live ordinary terminal-write exhaustion on the global storage surface', () => {
    render(
      { kind: 'interrupted', settledAt: 1, cause: 'terminal-commit-failed', recovery: 'resume' },
      'current-prompt'
    )
    expect(container.textContent).toBe('')
    expect(container.querySelector('[aria-label="Resume session"]')).toBeNull()
  })
})
