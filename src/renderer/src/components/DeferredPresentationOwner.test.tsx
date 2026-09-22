// @vitest-environment jsdom
import { act, lazy, StrictMode, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApplicationErrorBoundary } from './application-error-boundary'
import { DeferredPresentationOwner } from './DeferredPresentationOwner'

const deferredModule = (): {
  load: () => Promise<unknown>
  view: (active: boolean) => React.JSX.Element
  resolve: () => void
  reject: (error: Error) => void
} => {
  const Owner = ({ active }: { active: boolean }): React.JSX.Element => {
    const [count, setCount] = useState(0)
    return (
      <button data-active={String(active)} onClick={() => setCount(count + 1)}>
        {count}
      </button>
    )
  }
  let resolve!: (value: { default: typeof Owner }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ default: typeof Owner }>((yes, no) => {
    resolve = yes
    reject = no
  })
  const load = vi.fn(() => promise)
  const LazyOwner = lazy(load)
  const view = (active: boolean): React.JSX.Element => (
    <StrictMode>
      <ApplicationErrorBoundary>
        <div data-testid="home" />
        <DeferredPresentationOwner active={active}>
          {(current) => <LazyOwner active={current} />}
        </DeferredPresentationOwner>
      </ApplicationErrorBoundary>
    </StrictMode>
  )
  return { load, view, resolve: () => resolve({ default: Owner }), reject }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('deferred presentation lifecycle', () => {
  it('does not request an inactive owner and retains its state across close and reopen', async () => {
    const module = deferredModule()
    const result = render(module.view(false))
    expect(module.load).not.toHaveBeenCalled()
    result.rerender(module.view(true))
    expect(module.load).toHaveBeenCalledOnce()
    expect(screen.getByTestId('home')).toBeTruthy()
    await act(async () => module.resolve())
    fireEvent.click(screen.getByRole('button'))
    result.rerender(module.view(false))
    expect(screen.getByRole('button').dataset.active).toBe('false')
    expect(screen.getByRole('button').textContent).toBe('1')
    result.rerender(module.view(true))
    expect(screen.getByRole('button').dataset.active).toBe('true')
    expect(screen.getByRole('button').textContent).toBe('1')
    expect(module.load).toHaveBeenCalledOnce()
  })

  it('uses the latest closed state when first loading completes after dismissal', async () => {
    const module = deferredModule()
    const result = render(module.view(true))
    result.rerender(module.view(false))
    await act(async () => module.resolve())
    expect(screen.getByRole('button').dataset.active).toBe('false')
    result.rerender(module.view(true))
    expect(screen.getByRole('button').dataset.active).toBe('true')
    expect(module.load).toHaveBeenCalledOnce()
  })

  it('resumes an activation that was superseded while loading', async () => {
    const module = deferredModule()
    const result = render(module.view(false))
    result.rerender(module.view(true))
    result.rerender(module.view(false))
    result.rerender(module.view(true))
    await act(async () => module.resolve())
    expect(screen.getByRole('button').dataset.active).toBe('true')
    expect(module.load).toHaveBeenCalledOnce()
  })

  it('does not resurrect an owner when its host unmounts during loading', async () => {
    const module = deferredModule()
    const result = render(module.view(true))
    result.unmount()
    await act(async () => module.resolve())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('exposes the existing reload recovery if a presentation chunk fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const module = deferredModule()
    render(module.view(true))
    await act(async () => module.reject(new Error('Failed to fetch dynamically imported module')))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
  })
})
