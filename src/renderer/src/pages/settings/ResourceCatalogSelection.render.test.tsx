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
const Harness = ({ hideResources = false }: { hideResources?: boolean }): React.JSX.Element => {
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
            ids={
              hideResources
                ? []
                : resources.filter((item) => item.group === group).map((item) => item.id)
            }
          />
          {resources
            .filter((item) => !hideResources && item.group === group)
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
  it.each([0, 1, 5, 6])('shows batch search only above five eligible Specialists: %i', (count) => {
    useSpecialistStore.setState({
      items: Array.from({ length: count }, (_, index) => ({
        kind: 'custom' as const,
        id: `expert-${index}`,
        name: `Expert ${index}`,
        enabled: true,
        revision: 1,
        description: '',
        systemPrompt: '',
        capabilityMode: 'selected' as const,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      }))
    })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Personal skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Specialist' }))
    expect(screen.queryAllByRole('searchbox', { name: 'Search Specialists' })).toHaveLength(
      count > 5 ? 1 : 0
    )
    if (count > 5) {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Specialists' }), {
        target: { value: 'Expert 0' }
      })
      expect(screen.getAllByRole('button', { name: /^Expert/ })).toHaveLength(1)
      expect(screen.getByRole('searchbox', { name: 'Search Specialists' })).toBeTruthy()
    }
  })
  it('hides category selection for empty lists while preserving hidden selections', () => {
    const view = render(<Harness hideResources />)
    expect(screen.queryAllByRole('button', { name: /Select multiple in/ })).toHaveLength(0)
    view.rerender(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Personal skill' }))
    view.rerender(<Harness hideResources />)
    expect(
      screen.queryAllByRole('button', { name: /Select multiple in|Finish selection in/ })
    ).toHaveLength(0)
    expect(screen.queryAllByRole('checkbox', { name: /Select all in/ })).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Selected resources' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByRole('region', { name: 'Selected resources' })).toBeNull()
  })
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion 1' }))
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
    fireEvent.click(screen.getByRole('button', { name: /^Confirm deletion \d+$/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(remove).toHaveBeenCalledExactlyOnceWith('personal')
    expect(
      (screen.getByRole('checkbox', { name: 'Select Unused skill' }) as HTMLInputElement).checked
    ).toBe(true)
  })
  it.each(['missing API', 'failed read', 'degraded catalog'])(
    'fails closed when checking deletion with %s',
    async (failure) => {
      if (failure === 'missing API') window.api = {} as typeof window.api
      else if (failure === 'failed read')
        vi.mocked(window.api.specialist.list).mockRejectedValue(new Error('offline'))
      else
        vi.mocked(window.api.specialist.list).mockResolvedValue({
          items: [],
          integrity: { status: 'degraded', issues: [] }
        })
      render(<Harness />)
      fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion 1' }))
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
      expect(remove).not.toHaveBeenCalled()
    }
  )
  it('uses the checked snapshot even when a later refresh supersedes the store update', async () => {
    type Snapshot = Awaited<ReturnType<typeof window.api.specialist.list>>
    let resolveGuard!: (snapshot: Snapshot) => void
    let resolveLater!: (snapshot: Snapshot) => void
    vi.mocked(window.api.specialist.list)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGuard = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLater = resolve
          })
      )
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion 1' }))
    let later!: Promise<void>
    act(() => {
      later = useSpecialistStore.getState().load({ force: true })
    })
    const snapshot: Snapshot = {
      integrity: { status: 'ok' },
      items: [
        {
          kind: 'custom',
          id: 'expert',
          name: 'EXPERT',
          enabled: true,
          revision: 1,
          description: '',
          systemPrompt: '',
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: ['unused'], connectorIds: [], connectorTools: [] }
        }
      ]
    }
    await act(async () => {
      resolveGuard(snapshot)
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm deletion 1' })).toBeNull()
    )
    expect(remove).not.toHaveBeenCalled()
    await act(async () => {
      resolveLater(snapshot)
      await later
    })
  })
  it('recovers disabled bulk actions by explicitly retrying a failed catalog load', async () => {
    useSpecialistStore.setState({ loadError: 'temporary failure' })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Delete selected' }).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Delete selected' }).disabled
      ).toBe(false)
    )
    expect(screen.queryByText('Changes saved.')).toBeNull()
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
    expect(screen.queryByRole('button', { name: /^Confirm deletion \d+$/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete selected' }))
  })
  it('restores focus to a live control after deleting the entire selection', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm deletion \d+$/ }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Confirm deletion \d+$/ })).toBeNull()
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear selection' }))
  })
  it('restores focus to the deletion action after a usage snapshot read fails', async () => {
    vi.mocked(window.api.specialist.list).mockRejectedValue(new Error('catalog unavailable'))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Select multiple in personal' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Unused skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm deletion \d+$/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete selected' }))
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
    fireEvent.click(screen.getByRole('button', { name: /^Confirm deletion \d+$/ }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Delete selected resources?' }), {
      key: 'Escape'
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    await act(async () => finish())
    expect(screen.queryByRole('button', { name: /^Confirm deletion \d+$/ })).toBeNull()
  })
})
