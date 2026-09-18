// @vitest-environment jsdom
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { ResourceTagMenu, ResourceTagSummary } from './ResourceTagControls'
import type { TagSnapshot } from '../../../../shared/tags'

const storeSetAssignment = useTagStore.getState().setAssignment

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
  vi.stubGlobal('api', { tags: { setAssignment: vi.fn(), snapshot: vi.fn() } })
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
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ResourceTagMenu', () => {
  it('shows immediate checkmarks and accepts selection and removal while saves are pending', async () => {
    const finish: Array<(snapshot: TagSnapshot) => void> = []
    const write = vi.fn<Window['api']['tags']['setAssignment']>(
      () => new Promise<TagSnapshot>((resolve) => finish.push(resolve))
    )
    vi.spyOn(window.api.tags, 'setAssignment').mockImplementation(write)
    useTagStore.setState({ setAssignment: storeSetAssignment })
    const tags = useTagStore.getState().tags
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    const first = screen.getByRole('option', { name: 'ds-v4-flash' })
    const second = screen.getByRole('option', { name: 'ds-v4-pro' })
    fireEvent.click(first)
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(first.querySelector('.lucide-check')).not.toBeNull()
    expect(screen.getByRole('listbox').querySelector('.animate-spin')).toBeNull()
    expect(first.getAttribute('aria-disabled')).toBe('false')
    expect(second.getAttribute('aria-disabled')).toBe('false')
    expect(first.className).toContain('cursor-pointer')
    fireEvent.click(second)
    expect(second.getAttribute('aria-selected')).toBe('true')
    // Enter toggles the first option again before either save has finished.
    key('Enter')
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect(first.querySelector('.lucide-check')).toBeNull()
    expect(write.mock.calls.map(([request]) => request)).toEqual([
      { ...reference, tagId: 'tag-0', assigned: true },
      { ...reference, tagId: 'tag-1', assigned: true },
      { ...reference, tagId: 'tag-0', assigned: false }
    ])
    const assignments = [{ ...reference, tagId: 'tag-1', createdAt: 1 }]
    await act(async () => finish[2]({ revision: 3, tags, assignments }))
    await act(async () => finish[1]({ revision: 2, tags, assignments }))
    await act(async () =>
      finish[0]({
        revision: 1,
        tags,
        assignments: [{ ...reference, tagId: 'tag-0', createdAt: 1 }]
      })
    )
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect(second.getAttribute('aria-selected')).toBe('true')
  })

  it('rolls back a failed optimistic selection without losing another pending selection', async () => {
    let reject!: (error: Error) => void
    let finish!: (snapshot: TagSnapshot) => void
    vi.spyOn(window.api.tags, 'setAssignment')
      .mockImplementationOnce(
        () =>
          new Promise<TagSnapshot>((_, fail) => {
            reject = fail
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<TagSnapshot>((resolve) => {
            finish = resolve
          })
      )
    const tags = useTagStore.getState().tags
    vi.spyOn(window.api.tags, 'snapshot').mockResolvedValue({ revision: 0, tags, assignments: [] })
    useTagStore.setState({ setAssignment: storeSetAssignment })
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    const first = screen.getByRole('option', { name: 'ds-v4-flash' })
    const second = screen.getByRole('option', { name: 'ds-v4-pro' })
    fireEvent.click(first)
    fireEvent.click(second)
    await act(async () => reject(new Error('offline')))
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('Could not update Tags.')
    await act(async () =>
      finish({ revision: 1, tags, assignments: [{ ...reference, tagId: 'tag-1', createdAt: 1 }] })
    )
  })

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
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('true')
    await act(async () => reject(new Error('offline')))
    expect(screen.getByRole('alert').textContent).toBe('Could not update Tags.')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().value).toBe('New topic')
    key('Enter')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps existing Tags interactive while creation is pending', async () => {
    let finish!: (id: string) => void
    create.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<ResourceTagMenu reference={reference} />)
    openPicker()
    search('ds')
    fireEvent.click(screen.getByRole('option', { name: 'Create “ds”' }))
    fireEvent.click(screen.getByRole('option', { name: 'Create “ds”' }))
    const existing = screen.getByRole('option', { name: 'ds-v4-flash' })
    expect(existing.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(existing)
    expect(setAssignment).toHaveBeenCalledWith({ ...reference, tagId: 'tag-0', assigned: true })
    expect(create).toHaveBeenCalledOnce()
    await act(async () => finish('created'))
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

  it.each([true, false])(
    'keeps concurrent Settings failures visible (success first: %s)',
    async (successFirst) => {
      let succeed!: () => void
      let fail!: (error: Error) => void
      setAssignment
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              succeed = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              fail = reject
            })
        )
      render(<ResourceTagMenu reference={reference} keepOpenOnSelect={false} />)
      openPicker()
      fireEvent.click(screen.getByRole('option', { name: 'ds-v4-flash' }))
      fireEvent.click(screen.getByRole('option', { name: 'ds-v4-pro' }))
      if (successFirst) {
        await act(async () => succeed())
        expect(input()).not.toBeNull()
        await act(async () => fail(new Error('offline')))
      } else {
        await act(async () => fail(new Error('offline')))
        await act(async () => succeed())
      }
      expect(screen.getByRole('alert').textContent).toBe('Could not update Tags.')
      fireEvent.click(screen.getByRole('option', { name: 'ds-v4-pro' }))
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    }
  )

  it('keeps earlier saves accounted for when search changes before another selection', async () => {
    let fail!: (error: Error) => void
    let succeed!: () => void
    setAssignment
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            succeed = resolve
          })
      )
    render(<ResourceTagMenu reference={reference} keepOpenOnSelect={false} />)
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-flash' }))
    search('pro')
    key('Enter')
    await act(async () => succeed())
    expect(input().value).toBe('pro')
    await act(async () => fail(new Error('offline')))
    expect(screen.getByRole('alert').textContent).toBe('Could not update Tags.')
    expect(input().value).toBe('pro')
  })

  it('allows a successful retry to clear its failure while another save remains pending', async () => {
    let fail!: (error: Error) => void
    let succeed!: () => void
    setAssignment
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            succeed = resolve
          })
      )
    render(<ResourceTagMenu reference={reference} keepOpenOnSelect={false} />)
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-flash' }))
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-pro' }))
    await act(async () => fail(new Error('offline')))
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-flash' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input()).not.toBeNull()
    await act(async () => succeed())
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('closes Settings only once all concurrent saves succeed', async () => {
    const finish: Array<() => void> = []
    setAssignment.mockImplementation(() => new Promise<void>((resolve) => finish.push(resolve)))
    render(<ResourceTagMenu reference={reference} keepOpenOnSelect={false} />)
    openPicker()
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-flash' }))
    fireEvent.click(screen.getByRole('option', { name: 'ds-v4-pro' }))
    await act(async () => finish[1]())
    expect(input()).not.toBeNull()
    await act(async () => finish[0]())
    expect(screen.queryByRole('combobox')).toBeNull()
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
