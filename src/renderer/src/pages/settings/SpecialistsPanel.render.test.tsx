// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistsPanel } from './SpecialistsPanel'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root
const initialStore = useSpecialistStore.getState()
const specialistItems: SpecialistListItem[] = [
  {
    kind: 'custom',
    id: 'rna-reviewer',
    name: 'RNA Reviewer',
    description: 'Reviews RNA-seq analyses.',
    systemPrompt: '',
    iconKey: 'microscope',
    colorKey: 'teal',
    enabled: true,
    capabilityMode: 'full',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  {
    kind: 'custom',
    id: 'literature-reviewer',
    name: 'Literature Reviewer',
    description: 'Finds relevant papers.',
    systemPrompt: '',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  { kind: 'reviewer', id: 'reviewer' }
]

beforeEach(() => {
  window.api = {
    specialist: {
      list: vi.fn().mockResolvedValue(specialistItems),
      create: vi.fn(),
      setEnabled: vi.fn(),
      onCatalogChanged: vi.fn(() => vi.fn())
    },
    settings: {
      listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [], ncbi: null }),
      listSkills: vi.fn().mockResolvedValue([])
    }
  } as unknown as Window['api']
  useSpecialistStore.setState({
    ...initialStore,
    isLoaded: true,
    items: specialistItems
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useSpecialistStore.setState(initialStore, true)
  delete (window as unknown as { api?: unknown }).api
})

describe('SpecialistsPanel', () => {
  it('filters specialists by a user-entered search term', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const search = document.body.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search).not.toBeNull()
    await act(async () => {
      fireEvent.change(search!, { target: { value: 'literature' } })
    })

    expect(document.body.textContent).toContain('Literature Reviewer')
    expect(document.body.textContent).not.toContain('RNA Reviewer')
  })

  it('shows item counts in each filter tab', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const labels = Array.from(tabs).map((tab) => tab.textContent ?? '')
    // 2 custom + 1 built-in reviewer = 3 total
    expect(labels).toEqual(['All(3)', 'Custom(2)', 'Built-in(1)'])
  })

  it('filters the list to custom specialists when the Custom tab is clicked', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const custom = Array.from(tabs).find((tab) => tab.textContent?.includes('Custom'))
    expect(custom).toBeDefined()
    await act(async () => {
      custom!.click()
    })

    expect(document.body.textContent).toContain('RNA Reviewer')
    expect(document.body.textContent).not.toContain('Used by Auto-review')
  })

  it('shows each custom specialist capability mode in the list summary', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Full access')
    expect(document.body.textContent).toContain('Selected capabilities')
  })

  it('renders the saved icon for a custom specialist', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[data-specialist-icon="microscope"]')).not.toBeNull()
  })

  it('navigates to the edit view when a custom specialist row body is clicked', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const editButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Edit RNA Reviewer"]'
    )
    expect(editButton).not.toBeNull()
    await act(async () => {
      editButton!.click()
    })

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'rna-reviewer' })
  })

  it('renders the editor prefilled with the specialist data in the edit view', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    const name = document.body.querySelector<HTMLInputElement>('#sp-name')
    expect(name?.value).toBe('RNA Reviewer')
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent === 'Save changes'
      )
    ).toBe(true)
  })

  it('falls back to the list when the edited specialist no longer exists', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'missing-id' }} onNavigate={vi.fn()} />
      )
    })

    // No editor fields — the list view is rendered instead.
    expect(document.body.querySelector('#sp-name')).toBeNull()
    expect(
      document.body.querySelector('[aria-label="Filter specialists by category"]')
    ).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Concurrency and reload (Findings 1, 2, 3)
  // ---------------------------------------------------------------------------

  it('F1: save payload carries the original revision even after a catalog-changed refreshes props', async () => {
    // rev 1 at mount
    const updateMock = vi.fn().mockResolvedValue(specialistItems[0])
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        // Simulate remote write: rev bumped to 2 in the store
        useSpecialistStore.setState({
          items: specialistItems.map((item) =>
            item.kind === 'custom' && item.id === 'rna-reviewer' ? { ...item, revision: 2 } : item
          )
        })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Dirty the form so the save button becomes active.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer Edited' }
      })
    })

    // Simulate catalog-changed: trigger load which bumps store to rev 2.
    const onCatalogChangedCb = (window.api.specialist.onCatalogChanged as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as (() => void) | undefined
    if (onCatalogChangedCb) {
      await act(async () => {
        onCatalogChangedCb()
      })
    }

    // Click Save — payload must still carry revision 1 (the pinned base revision).
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))
  })

  it('F2: Reload actually replaces form content with the latest profile data', async () => {
    // updateMock rejects with a conflict so the banner appears.
    const updateMock = vi
      .fn()
      .mockRejectedValue(new Error('Revision conflict: expected 1, found 2.'))
    // After reload, list returns rev 2 with updated name.
    const updatedItems = specialistItems.map((item) =>
      item.kind === 'custom' && item.id === 'rna-reviewer'
        ? { ...item, revision: 2, name: 'RNA Reviewer Updated', description: 'Updated desc' }
        : item
    ) as SpecialistListItem[]

    let listCallCount = 0
    ;(window.api.specialist as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      async () => {
        listCallCount++
        if (listCallCount > 1) return updatedItems
        return specialistItems
      }
    )
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        const items = await window.api.specialist.list()
        useSpecialistStore.setState({ items })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Click Save to trigger conflict.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(document.body.querySelector('[aria-label="Revision conflict"]')).not.toBeNull()

    // Click Reload.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Reload')
        ?.click()
    })

    // Form should now show the updated name from the reloaded profile.
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe(
      'RNA Reviewer Updated'
    )
    // Conflict banner is gone.
    expect(document.body.querySelector('[aria-label="Revision conflict"]')).toBeNull()
  })

  it('F3: a rejected delete keeps the dialog open and shows an error', async () => {
    const deleteMock = vi.fn().mockRejectedValue(new Error('Revision conflict — try again.'))
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      delete: deleteMock,
      load: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    // Open the actions dropdown for RNA Reviewer.
    const actionsBtn = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for RNA Reviewer"]'
    )
    expect(actionsBtn).not.toBeNull()
    openRadixMenu(actionsBtn)
    await act(async () => {
      // small tick to let Radix open the menu
    })

    // Click Delete in the dropdown.
    const deleteItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Delete'))
    expect(deleteItem).not.toBeNull()
    await act(async () => {
      clickRadixMenuItem(deleteItem)
    })

    // Confirm deletion in the dialog.
    const confirmBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'Delete' && btn.closest('[role="alertdialog"]') !== null
    )
    expect(confirmBtn).not.toBeNull()
    await act(async () => {
      confirmBtn!.click()
    })

    // Dialog stays open and shows the error.
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/revision conflict|try again/i)
  })
})
