// @vitest-environment jsdom
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { ResourceTagMenu, ResourceTagSummary } from './ResourceTagControls'

const reference = { resourceType: 'literature.item' as const, resourceId: 'paper-a' }
const create = vi.fn()
const setAssignment = vi.fn()
const input = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Search Tags' })
const active = (): HTMLElement | null =>
  document.getElementById(input().getAttribute('aria-activedescendant') ?? '')
const openPicker = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Manage Tags' }))
}
const search = (value: string): void => {
  fireEvent.change(input(), { target: { value } })
}
const key = (value: string): void => {
  fireEvent.keyDown(input(), { key: value })
}

beforeEach(() => {
  create.mockReset().mockResolvedValue('created')
  setAssignment.mockReset().mockResolvedValue(undefined)
  useTagStore.setState({
    ...createInitialTagState(),
    status: 'ready',
    tags: ['ds-v4-flash', 'ds-v4-pro'].map((name, index) => ({
      id: `tag-${index}`,
      name,
      iconKey: 'tag',
      colorKey: 'blue',
      createdAt: 1,
      updatedAt: 1
    })),
    create,
    setAssignment
  })
})
afterEach(cleanup)

describe('ResourceTagMenu', () => {
  it('focuses search, navigates matches and Create with arrows, and selects with Enter', async () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    expect(document.activeElement).toBe(input())
    search('ds')
    expect(active()?.textContent).toBe('ds-v4-flash')
    key('ArrowDown')
    expect(active()?.textContent).toBe('ds-v4-pro')
    key('Enter')
    await waitFor(() =>
      expect(setAssignment).toHaveBeenCalledWith({ ...reference, tagId: 'tag-1', assigned: true })
    )
    expect(document.activeElement).toBe(input())
    key('ArrowDown')
    expect(active()?.textContent).toBe('Create “ds”')
    key('Enter')
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: 'ds', iconKey: 'tag', colorKey: 'blue' })
    )
    await waitFor(() =>
      expect(setAssignment).toHaveBeenCalledWith({ ...reference, tagId: 'created', assigned: true })
    )
    expect(input().value).toBe('')
  })

  it('creates directly without matches, but suppresses empty or normalized duplicate creation', async () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('  ＤＳ-v4-FLASH  ')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(active()?.textContent).toBe('ds-v4-flash')
    search('   ')
    expect(screen.queryByText('Create “ ”')).toBeNull()
    search('New topic')
    expect(active()?.textContent).toBe('Create “New topic”')
    key('Enter')
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
  })

  it('ignores IME confirmation and preserves ordinary text editing keys', () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('新标签')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    expect(create).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(input(), { key: 'Home' })).toBe(true)
    expect(fireEvent.keyDown(input(), { key: 'End' })).toBe(true)
    expect(fireEvent.keyDown(input(), { key: 'ArrowLeft' })).toBe(true)
  })

  it('wraps arrow navigation and resets a stale active result after filtering or deletion', () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    key('ArrowUp')
    expect(active()?.textContent).toBe('ds-v4-pro')
    search('flash')
    expect(active()?.textContent).toBe('ds-v4-flash')
    act(() => useTagStore.setState({ tags: [] }))
    expect(active()?.textContent).toBe('Create “flash”')
  })

  it('announces assignments independently from active highlighting and supports mouse removal', async () => {
    useTagStore.setState({ assignments: [{ ...reference, tagId: 'tag-0', createdAt: 1 }] })
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    const assigned = screen.getByRole('option', { name: 'ds-v4-flash', selected: true })
    fireEvent.pointerMove(screen.getByRole('option', { name: 'ds-v4-pro' }))
    expect(active()?.textContent).toBe('ds-v4-pro')
    fireEvent.mouseDown(assigned)
    fireEvent.click(assigned)
    await waitFor(() =>
      expect(setAssignment).toHaveBeenCalledWith({ ...reference, tagId: 'tag-0', assigned: false })
    )
    expect(document.activeElement).toBe(input())
  })

  it('deduplicates rapid keyboard and pointer activation while pending and allows retry after failure', async () => {
    let reject: (error: Error) => void = () => undefined
    create.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise
        })
    )
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('New topic')
    key('Enter')
    key('Enter')
    fireEvent.click(screen.getByRole('option'))
    expect(create).toHaveBeenCalledOnce()
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true')
    await act(async () => reject(new Error('offline')))
    expect(screen.getByRole('alert').textContent).toBe('Could not update Tags.')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().value).toBe('New topic')
    key('Enter')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains a newly created Tag after assignment fails so retry assigns without creating twice', async () => {
    create.mockImplementationOnce(async () => {
      useTagStore.setState((state) => ({
        tags: [
          ...state.tags,
          {
            id: 'created',
            name: 'New topic',
            iconKey: 'tag',
            colorKey: 'blue',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }))
      return 'created'
    })
    setAssignment.mockRejectedValueOnce(new Error('assignment failed'))
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('New topic')
    key('Enter')
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(input().value).toBe('New topic')
    expect(active()?.textContent).toBe('New topic')
    key('Enter')
    await waitFor(() => expect(setAssignment).toHaveBeenCalledTimes(2))
    expect(create).toHaveBeenCalledOnce()
  })

  it('does not write from an empty list or a disabled resource trigger', () => {
    useTagStore.setState({ tags: [] })
    const view = render(<ResourceTagMenu reference={reference} />)
    openPicker()
    expect(input().getAttribute('aria-activedescendant')).toBeNull()
    key('ArrowDown')
    key('Enter')
    expect(create).not.toHaveBeenCalled()
    expect(setAssignment).not.toHaveBeenCalled()
    key('Escape')
    view.rerender(
      <ResourceTagMenu
        reference={reference}
        trigger={<button disabled aria-label="Manage Tags" />}
      />
    )
    openPicker()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('preserves the current query when a previous creation finishes after the user types again', async () => {
    let resolve: (value: string) => void = () => undefined
    create.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          resolve = resolvePromise
        })
    )
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('First')
    key('Enter')
    search('Second')
    await act(async () => resolve('created'))
    expect(input().value).toBe('Second')
  })

  it('closes with Escape and restores trigger focus without selecting', async () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('New topic')
    key('Escape')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage Tags' }))
    )
    expect(create).not.toHaveBeenCalled()
    openPicker()
    expect(input().value).toBe('')
  })

  it('dismisses on Tab without consuming its default focus navigation or selecting', () => {
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('New topic')
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('supports controlled opening and the Settings summary close-on-success policy', async () => {
    function Controlled(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <ResourceTagSummary
          reference={{ resourceType: 'catalog.skill', resourceId: 'skill-a' }}
          menuOpen={open}
          onMenuOpenChange={setOpen}
        />
      )
    }
    render(<Controlled />)
    openPicker()
    key('Enter')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    expect(setAssignment).toHaveBeenCalledWith({
      resourceType: 'catalog.skill',
      resourceId: 'skill-a',
      tagId: 'tag-0',
      assigned: true
    })
  })

  it('does not let a stale completion clear a reopened picker or a different resource', async () => {
    let resolve: (value: string) => void = () => undefined
    create.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          resolve = resolvePromise
        })
    )
    const view = render(<ResourceTagMenu reference={reference} keepOpenOnSelect={false} />)
    openPicker()
    search('First')
    key('Enter')
    key('Escape')
    view.rerender(
      <ResourceTagMenu
        reference={{ ...reference, resourceId: 'paper-b' }}
        keepOpenOnSelect={false}
      />
    )
    openPicker()
    search('Second')
    await act(async () => resolve('created'))
    expect(input().value).toBe('Second')
    expect(setAssignment).toHaveBeenCalledWith({ ...reference, tagId: 'created', assigned: true })
  })
})
