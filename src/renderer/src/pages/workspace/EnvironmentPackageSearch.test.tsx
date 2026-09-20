// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EnvironmentPackageSearch } from './EnvironmentPackageSearch'

describe('EnvironmentPackageSearch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const advance = (milliseconds: number): void => {
    act(() => vi.advanceTimersByTime(milliseconds))
  }
  const input = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Search packages' })

  it('keeps typing immediate and applies only the last query after a pause', () => {
    const onSearch = vi.fn()
    render(<EnvironmentPackageSearch initialQuery="" onSearch={onSearch} />)
    for (const value of ['n', 'nu', 'num']) {
      fireEvent.change(input(), { target: { value } })
      expect(input().value).toBe(value)
      advance(200)
      expect(onSearch).not.toHaveBeenCalled()
    }
    advance(50)
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('num')
  })

  it('waits for composition to finish even when the user pauses to choose a candidate', () => {
    const onSearch = vi.fn()
    render(<EnvironmentPackageSearch initialQuery="" onSearch={onSearch} />)
    fireEvent.change(input(), { target: { value: 'n' } })
    fireEvent.compositionStart(input())
    fireEvent.change(input(), { target: { value: 'ni' } })
    advance(1000)
    expect(onSearch).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input(), { data: '你', target: { value: '你' } })
    advance(249)
    expect(onSearch).not.toHaveBeenCalled()
    advance(1)
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('你')
  })

  it('clears immediately and cancels a pending query', () => {
    const onSearch = vi.fn()
    render(<EnvironmentPackageSearch initialQuery="numpy" onSearch={onSearch} />)
    fireEvent.change(input(), { target: { value: 'pandas' } })
    advance(100)
    fireEvent.change(input(), { target: { value: '' } })
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('')
    advance(1000)
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it('cancels pending filtering on version changes and unmount', () => {
    const onSearch = vi.fn()
    const view = render(<EnvironmentPackageSearch key="v1" initialQuery="" onSearch={onSearch} />)
    fireEvent.change(input(), { target: { value: 'numpy' } })
    view.rerender(<EnvironmentPackageSearch key="v2" initialQuery="ggplot2" onSearch={onSearch} />)
    expect(input().value).toBe('ggplot2')
    advance(1000)
    expect(onSearch).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: 'readr' } })
    view.unmount()
    advance(1000)
    expect(onSearch).not.toHaveBeenCalled()
  })
})
