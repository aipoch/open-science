// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReplayMaterialActionProvider,
  useReplayMaterialAction,
  type ReplayMaterialAction
} from './replay-material-action'

const Material = ({ action }: { action?: ReplayMaterialAction }): React.JSX.Element | null => {
  useReplayMaterialAction(action)
  return null
}

afterEach(cleanup)

describe('research replay material action registration', () => {
  it('replaces decoded timestamps and labels without publishing an unavailable action', () => {
    const changes = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const action: ReplayMaterialAction = {
      label: 'Ask about this moment',
      recordedAt: 1000,
      title: 'Recorded project',
      onAsk: vi.fn()
    }
    const tree = (value: ReplayMaterialAction): React.JSX.Element => (
      <ReplayMaterialActionProvider onActionChange={changes}>
        <Material action={value} />
      </ReplayMaterialActionProvider>
    )
    const view = render(tree(action))
    view.rerender(tree({ ...action, recordedAt: 1250 }))
    view.rerender(tree({ ...action, recordedAt: 1500, title: 'Updated project' }))
    view.rerender(tree({ ...action, recordedAt: 1500, label: 'Ask about this file' }))

    expect(changes.mock.calls.map(([value]) => value?.recordedAt)).toEqual([1000, 1250, 1500, 1500])
    expect(changes.mock.calls.every(([value]) => value && !value.disabled)).toBe(true)
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'Ask about this file', recordedAt: 1500 })
    )
  })

  it('keeps registered callbacks current and blocks them while disabled, pending, or absent', () => {
    const changes = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const firstAsk = vi.fn()
    const latestAsk = vi.fn()
    const action: ReplayMaterialAction = {
      label: 'Ask about this moment',
      recordedAt: 1000,
      onAsk: firstAsk
    }
    const tree = (value?: ReplayMaterialAction): React.JSX.Element => (
      <ReplayMaterialActionProvider onActionChange={changes}>
        <Material action={value} />
      </ReplayMaterialActionProvider>
    )
    const view = render(tree(action))
    const registered = changes.mock.lastCall![0]!
    view.rerender(tree({ ...action, onAsk: latestAsk }))
    expect(changes).toHaveBeenCalledTimes(1)
    registered.onAsk()
    expect(firstAsk).not.toHaveBeenCalled()
    expect(latestAsk).toHaveBeenCalledOnce()

    view.rerender(tree({ ...action, onAsk: latestAsk, disabled: true }))
    registered.onAsk()
    view.rerender(tree({ ...action, onAsk: latestAsk, pending: true }))
    registered.onAsk()
    expect(latestAsk).toHaveBeenCalledOnce()
    expect(changes.mock.calls.every(([value]) => value !== undefined)).toBe(true)

    view.rerender(tree())
    registered.onAsk()
    expect(latestAsk).toHaveBeenCalledOnce()
    expect(changes).toHaveBeenLastCalledWith(undefined)
    const publications = changes.mock.calls.length
    view.unmount()
    expect(changes).toHaveBeenCalledTimes(publications)
  })

  it('revokes an available action when unmounted', () => {
    const changes = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const ask = vi.fn()
    const view = render(
      <ReplayMaterialActionProvider onActionChange={changes}>
        <Material action={{ label: 'Ask about this moment', onAsk: ask }} />
      </ReplayMaterialActionProvider>
    )
    const registered = changes.mock.lastCall![0]!
    changes.mockClear()
    view.unmount()
    expect(changes).toHaveBeenCalledExactlyOnceWith(undefined)
    registered.onAsk()
    expect(ask).not.toHaveBeenCalled()
  })

  it('revokes the old provider registration and restores it when the provider is enabled again', () => {
    const changes = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const action = { label: 'Ask about this moment', onAsk: vi.fn() }
    const tree = (enabled: boolean): React.JSX.Element => (
      <ReplayMaterialActionProvider enabled={enabled} onActionChange={changes}>
        <Material action={action} />
      </ReplayMaterialActionProvider>
    )
    const view = render(tree(true))
    const registered = changes.mock.lastCall![0]!
    changes.mockClear()
    view.rerender(tree(false))
    expect(changes).toHaveBeenCalledExactlyOnceWith(undefined)
    registered.onAsk()
    expect(action.onAsk).not.toHaveBeenCalled()
    view.rerender(tree(true))
    expect(changes).toHaveBeenCalledTimes(2)
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ label: action.label }))
    changes.mock.lastCall![0]!.onAsk()
    expect(action.onAsk).toHaveBeenCalledOnce()
  })

  it('does not clear a newer owner when an earlier material loses its action or unmounts', () => {
    const changes = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const first = { label: 'Ask about this moment', onAsk: vi.fn() }
    const second = { label: 'Ask about this file', onAsk: vi.fn() }
    const tree = (firstState: 'available' | 'absent' | 'unmounted'): React.JSX.Element => (
      <ReplayMaterialActionProvider onActionChange={changes}>
        {firstState === 'unmounted' ? null : (
          <Material key="first" action={firstState === 'available' ? first : undefined} />
        )}
        <Material key="second" action={second} />
      </ReplayMaterialActionProvider>
    )
    const view = render(tree('available'))
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ label: second.label }))
    changes.mockClear()
    view.rerender(tree('absent'))
    view.rerender(tree('unmounted'))
    expect(changes).not.toHaveBeenCalled()
    view.unmount()
    expect(changes).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
