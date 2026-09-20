import { useResourceSelection } from './use-resource-selection'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpecialistStore } from '@/stores/specialist-store'
import {
  ResourceCategorySelection,
  ResourceSelectionBar,
  ResourceSelectionCheckbox
} from './ResourceCatalogSelection'

const seed = [
  {
    id: 'featured',
    name: 'Featured skill',
    kind: 'skill' as const,
    group: 'featured',
    mainEnabled: true,
    mainRequired: true
  },
  {
    id: 'personal',
    name: 'Personal skill',
    kind: 'skill' as const,
    group: 'personal',
    mainEnabled: true,
    deletable: true
  },
  {
    id: 'unused',
    name: 'Unused skill',
    kind: 'skill' as const,
    group: 'personal',
    mainEnabled: false,
    deletable: true
  }
]
const remove = vi.fn().mockResolvedValue(undefined)
const Harness = (): React.JSX.Element => {
  const [resources, setResources] = useState(seed)
  const selection = useResourceSelection({
    resources,
    onSetMain: async (id, enabled) => {
      setResources((current) =>
        current.map((item) => (item.id === id ? { ...item, mainEnabled: enabled } : item))
      )
    },
    onDelete: remove
  })
  return (
    <>
      {['featured', 'personal'].map((group) => (
        <section key={group}>
          <ResourceCategorySelection
            selection={selection}
            group={group}
            label={group}
            ids={resources.filter((item) => item.group === group).map((item) => item.id)}
          />
          {resources
            .filter((item) => item.group === group)
            .map((resource) => (
              <ResourceSelectionCheckbox
                key={resource.id}
                selection={selection}
                resource={resource}
              />
            ))}
        </section>
      ))}
      <ResourceSelectionBar selection={selection} />
    </>
  )
}
beforeEach(() => {
  remove.mockClear()
  useSpecialistStore.setState({
    items: [],
    isLoaded: true,
    integrity: { status: 'ok' },
    loadError: undefined
  })
  window.api = {
    specialist: { list: vi.fn().mockResolvedValue({ items: [], integrity: { status: 'ok' } }) }
  } as unknown as typeof window.api
})
afterEach(cleanup)

describe('category resource selection', () => {
  it('selects one category independently, exposes only applicable actions and preserves required skills', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in featured' }))
    expect(screen.queryByRole('checkbox', { name: 'Select Personal skill' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Featured skill' }))
    expect(screen.queryByRole('button', { name: /Stop Main Agent loading/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Personal skill' }))
    fireEvent.click(screen.getByRole('button', { name: /Stop Main Agent loading/ }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Stop Main Agent loading/ })).toBeNull()
    )
    expect(
      screen
        .getByRole('checkbox', { name: 'Select Featured skill' })
        .getAttribute('aria-checked') ??
        (screen.getByRole('checkbox', { name: 'Select Featured skill' }) as HTMLInputElement)
          .checked
    ).toBe(true)
    expect(remove).not.toHaveBeenCalled()
  })
  it('reviews a mixed selection and deletes only eligible personal resources', async () => {
    render(<Harness />)
    for (const group of ['featured', 'personal'])
      fireEvent.click(screen.getByRole('button', { name: `Select multiple in ${group}` }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Featured skill' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Personal skill' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('personal'))
  })
  it('rechecks references for each deletion after earlier asynchronous cleanup', async () => {
    remove.mockImplementationOnce(async () => {
      const profile = {
        kind: 'custom' as const,
        id: 'new-owner',
        name: 'NEW_OWNER',
        enabled: true,
        revision: 1,
        description: '',
        systemPrompt: '',
        capabilityMode: 'selected' as const,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: ['unused'], connectorIds: [], connectorTools: [] }
      }
      vi.mocked(window.api.specialist.list).mockResolvedValue({
        items: [profile],
        integrity: { status: 'ok' }
      })
    })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all in personal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(remove).toHaveBeenCalledExactlyOnceWith('personal')
    expect(
      (screen.getByRole('checkbox', { name: 'Select Unused skill' }) as HTMLInputElement).checked
    ).toBe(true)
  })
  it('focuses deletion review and restores the trigger after Escape', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    const trigger = screen.getByRole('button', { name: 'Delete selected' })
    act(() => trigger.focus())
    fireEvent.click(trigger)
    expect(document.activeElement?.closest('[data-slot="batch-manage-review"]')).not.toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Confirm deletion' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete selected' }))
  })
  it('restores focus to a live control after deleting the entire selection', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm deletion' })).toBeNull()
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear selection' }))
  })
  it('restores focus to Clear when a catalog failure disables deletion', async () => {
    vi.mocked(window.api.specialist.list).mockRejectedValue(new Error('catalog unavailable'))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear selection' }))
  })
  it('keeps a pending deletion review open when Escape is pressed', async () => {
    let finish!: () => void
    remove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Delete selected resources?' }), {
      key: 'Escape'
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    await act(async () => finish())
    expect(screen.queryByRole('button', { name: 'Confirm deletion' })).toBeNull()
  })
})
