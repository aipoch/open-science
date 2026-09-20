// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedVersionDiffError } from './ManagedVersionDiffError'

afterEach(cleanup)

it.each([
  ['DIFF_INPUT_LIMIT_EXCEEDED', '2 MiB', false],
  ['DIFF_OUTPUT_LIMIT_EXCEEDED', 'display limit', false],
  ['DIFF_TIMEOUT', 'time limit', true],
  ['DIFF_CONCURRENCY_LIMIT', 'Other comparisons', true],
  ['STORAGE_UNAVAILABLE', 'storage location', true]
] as const)(
  'explains %s and offers the appropriate recovery action',
  (code, explanation, retryable) => {
    const onRetry = vi.fn()
    const onView = vi.fn()
    render(<ManagedVersionDiffError error={{ code }} onRetry={onRetry} onView={onView} />)
    expect(screen.getByRole('alert').textContent).toContain(explanation)
    const retry = screen.queryByRole('button', { name: 'Retry' })
    expect(Boolean(retry)).toBe(retryable)
    if (retry) {
      fireEvent.click(retry)
      expect(onRetry).toHaveBeenCalledTimes(1)
    }
    fireEvent.click(screen.getByRole('button', { name: 'View version' }))
    expect(onView).toHaveBeenCalledTimes(1)
  }
)
