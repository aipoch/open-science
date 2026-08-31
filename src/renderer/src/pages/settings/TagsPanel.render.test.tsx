// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { ResourceTagBadges } from './ResourceTagControls'
import { TagsPanel } from './TagsPanel'

let container: HTMLDivElement
let root: Root

const dispatchPointer = (
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientY: number
): void => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' }
  })
  act(() => element.dispatchEvent(event))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [
      {
        id: 'analysis',
        name: 'analysis',
        displayName: 'Analysis',
        description: 'Analyze data',
        source: 'featured',
        enabled: true,
        updatedAt: '2026-08-19T00:00:00.000Z'
      }
    ],
    loadSkills: vi.fn().mockResolvedValue(undefined),
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  useSpecialistStore.setState({ items: [], load: vi.fn().mockResolvedValue(undefined) })
  useTagStore.setState({
    ...createInitialTagState(),
    status: 'ready',
    revision: 1,
    tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
    assignments: [
      {
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill',
        resourceId: 'analysis',
        createdAt: 1
      }
    ]
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'elementFromPoint')
})

describe('TagsPanel', () => {
  it('aggregates tagged resources and opens their owning Settings detail', async () => {
    const onOpenResource = vi.fn()
    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={onOpenResource} />
      )
    })

    expect(container.textContent).toContain('Favorites')
    expect(container.textContent).toContain('Analysis')
    const resource = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Analysis')
    )
    act(() => resource?.click())
    expect(onOpenResource).toHaveBeenCalledWith({
      resourceType: 'catalog.skill',
      resourceId: 'analysis',
      title: 'Analysis',
      subtitle: 'Analyze data'
    })
  })

  it('opens create as a Settings sub-view and returns to the created Tag', async () => {
    const onNavigate = vi.fn()
    const createTag = vi.fn().mockResolvedValue('tag-research')
    useTagStore.setState({ create: createTag })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={onNavigate} onOpenResource={vi.fn()} />
      )
    })

    const newTag = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'New Tag'
    )
    act(() => newTag?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'create' })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'create' }} onNavigate={onNavigate} onOpenResource={vi.fn()} />
      )
    })
    const name = container.querySelector<HTMLInputElement>('#tag-form-name')
    act(() => {
      if (!name) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'Research'
      )
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLFormElement>('[data-slot="tag-form"]')?.requestSubmit()
    })

    expect(createTag).toHaveBeenCalledWith({
      name: 'Research',
      iconKey: 'tag',
      colorKey: 'blue'
    })
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'list', tagId: 'tag-research' })
  })

  it('edits a custom Tag in the Settings sub-view', async () => {
    const onNavigate = vi.fn()
    const updateTag = vi.fn().mockResolvedValue(undefined)
    useTagStore.setState({
      update: updateTag,
      tags: [
        {
          id: 'tag-research',
          name: 'Research',
          iconKey: 'book-open',
          colorKey: 'purple',
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })

    await act(async () => {
      root.render(
        <TagsPanel
          view={{ kind: 'edit', tagId: 'tag-research' }}
          onNavigate={onNavigate}
          onOpenResource={vi.fn()}
        />
      )
    })

    const name = container.querySelector<HTMLInputElement>('#tag-form-name')
    expect(name?.value).toBe('Research')
    expect(container.querySelector('[aria-label="Book"][aria-pressed="true"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Purple"][aria-pressed="true"]')).not.toBeNull()

    act(() => {
      if (!name) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'Literature'
      )
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLFormElement>('[data-slot="tag-form"]')?.requestSubmit()
    })

    expect(updateTag).toHaveBeenCalledWith({
      id: 'tag-research',
      expectedUpdatedAt: 2,
      name: 'Literature',
      iconKey: 'book-open',
      colorKey: 'purple'
    })
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list', tagId: 'tag-research' })
  })

  it('omits the secondary line when a resource has no description', async () => {
    useSettingsStore.setState((state) => ({
      skills: state.skills.map((skill) => ({ ...skill, description: '' }))
    }))

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    const resourceRow = container.querySelector('[data-slot="tag-resource-row"]')
    expect(resourceRow?.textContent?.trim()).toBe('Analysis')
    expect(resourceRow?.querySelector('[data-slot="tag-resource-subtitle"]')).toBeNull()
  })

  it('keeps custom connector identities visible and accessible', async () => {
    useSettingsStore.setState({
      skills: [],
      customServers: [
        {
          id: 'custom-alpha',
          name: 'alpha-mcp',
          displayName: 'Lab connector',
          description: 'Search papers',
          transport: 'stdio',
          enabled: true
        },
        {
          id: 'custom-beta',
          name: 'beta-mcp',
          displayName: 'Lab connector',
          transport: 'stdio',
          enabled: true
        }
      ]
    })
    useTagStore.setState({
      assignments: ['custom-alpha', 'custom-beta'].map((resourceId, index) => ({
        tagId: 'tag-favorite',
        resourceType: 'catalog.connector' as const,
        resourceId,
        createdAt: index + 1
      }))
    })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    expect(
      Array.from(container.querySelectorAll('[data-slot="tag-resource-subtitle"]')).map(
        (subtitle) => subtitle.textContent
      )
    ).toEqual(['alpha-mcp · Search papers', 'beta-mcp'])
    expect(
      Array.from(container.querySelectorAll('button[aria-label^="Remove Lab connector"]')).map(
        (button) => button.getAttribute('aria-label')
      )
    ).toEqual([
      'Remove Lab connector (alpha-mcp) from Favorites',
      'Remove Lab connector (beta-mcp) from Favorites'
    ])
  })

  it('limits compact resource Tags and summarizes the overflow', () => {
    useTagStore.setState({
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-research',
          name: 'Research with an intentionally long Tag name',
          iconKey: 'flask-conical',
          colorKey: 'purple',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'tag-production',
          name: 'Production',
          iconKey: 'database',
          colorKey: 'green',
          createdAt: 3,
          updatedAt: 3
        },
        {
          id: 'tag-writing',
          name: 'Writing',
          iconKey: 'bookmark',
          colorKey: 'blue',
          createdAt: 4,
          updatedAt: 4
        }
      ],
      assignments: ['tag-favorite', 'tag-research', 'tag-production', 'tag-writing'].map(
        (tagId, index) => ({
          tagId,
          resourceType: 'catalog.skill' as const,
          resourceId: 'analysis',
          createdAt: index + 1
        })
      )
    })

    act(() => {
      root.render(
        <ResourceTagBadges reference={{ resourceType: 'catalog.skill', resourceId: 'analysis' }} />
      )
    })

    expect(container.textContent).toContain('Favorites')
    const longName = container.querySelector(
      '[title="Research with an intentionally long Tag name"]'
    )
    expect(longName?.className).toContain('truncate')
    expect(longName?.parentElement?.className).toContain('max-w-24')
    expect(longName?.parentElement?.className).toContain('overflow-hidden')
    expect(container.textContent).toContain('+2')
    expect(container.textContent).not.toContain('Production')
    expect(container.firstElementChild?.className).toContain('overflow-hidden')
  })

  it("renders a resource's Tags in the persisted global order", () => {
    useTagStore.setState({
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-beta',
          name: 'Beta',
          iconKey: 'bookmark',
          colorKey: 'green',
          createdAt: 3,
          updatedAt: 3
        },
        {
          id: 'tag-alpha',
          name: 'Alpha',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      assignments: ['tag-alpha', 'tag-favorite', 'tag-beta'].map((tagId, index) => ({
        tagId,
        resourceType: 'catalog.skill' as const,
        resourceId: 'analysis',
        createdAt: index + 1
      }))
    })

    act(() => {
      root.render(
        <ResourceTagBadges
          reference={{ resourceType: 'catalog.skill', resourceId: 'analysis' }}
          limit={Number.POSITIVE_INFINITY}
        />
      )
    })

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[title]')).map(
        (element) => element.textContent
      )
    ).toEqual(['Favorites', 'Beta', 'Alpha'])
  })

  it('opens a Tag from its resource badge and removes the assignment without navigating', async () => {
    const onOpenTag = vi.fn()
    const setAssignment = vi.fn().mockResolvedValue(undefined)
    useTagStore.setState({ setAssignment })

    act(() => {
      root.render(
        <ResourceTagBadges
          reference={{ resourceType: 'catalog.skill', resourceId: 'analysis' }}
          onOpenTag={onOpenTag}
        />
      )
    })

    const openTag = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Favorites'
    )
    expect(openTag?.firstElementChild?.className).not.toContain('pr-6')
    act(() => openTag?.click())
    expect(onOpenTag).toHaveBeenCalledWith('tag-favorite')

    const removeTag = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Favorites from this resource"]'
    )
    expect(removeTag?.className).toContain('bg-background')
    expect(removeTag?.className).toContain('sm:pointer-events-none')
    expect(removeTag?.className).toContain('sm:group-hover/tag:pointer-events-auto')
    await act(async () => removeTag?.click())

    expect(setAssignment).toHaveBeenCalledWith({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'analysis',
      assigned: false
    })
    expect(onOpenTag).toHaveBeenCalledTimes(1)
  })

  it('shows a visible error when removing a resource Tag fails', async () => {
    useTagStore.setState({ setAssignment: vi.fn().mockRejectedValue(new Error('write failed')) })

    act(() => {
      root.render(
        <ResourceTagBadges
          reference={{ resourceType: 'catalog.skill', resourceId: 'analysis' }}
          onOpenTag={vi.fn()}
        />
      )
    })

    const removeTag = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Favorites from this resource"]'
    )
    await act(async () => removeTag?.click())

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toBe('Could not update Tags.')
    expect(alert?.className).toContain('text-destructive')
    expect(alert?.className).not.toContain('sr-only')
  })

  it('removes a hovered resource from the selected Tag', async () => {
    const setAssignment = vi.fn().mockResolvedValue(undefined)
    useTagStore.setState({ setAssignment })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    const removeResource = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Analysis from Favorites"]'
    )
    expect(removeResource?.className).toContain('sm:pointer-events-none')
    expect(removeResource?.className).toContain('sm:group-hover:pointer-events-auto')
    await act(async () => removeResource?.click())

    expect(setAssignment).toHaveBeenCalledWith({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'analysis',
      assigned: false
    })
  })

  it('renders icon-aligned resource groups that start expanded and can collapse', async () => {
    useSettingsStore.setState({
      connectors: [
        {
          id: 'pubmed',
          name: 'pubmed',
          displayName: 'PubMed',
          description: 'Biomedical literature',
          sources: ['NCBI'],
          requiresNcbi: true,
          enabled: true,
          autoAllow: false,
          group: 'directory'
        }
      ]
    })
    useSpecialistStore.setState({
      items: [
        {
          kind: 'builtin',
          readonly: true,
          id: 'auto-research',
          name: 'AUTO_RESEARCH',
          displayName: 'Auto Research',
          description: 'Research specialist',
          systemPrompt: 'Research',
          iconKey: 'bot',
          colorKey: 'blue',
          version: '1.0.0',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ]
    })
    useTagStore.setState({
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'analysis',
          createdAt: 1
        },
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.connector',
          resourceId: 'pubmed',
          createdAt: 2
        },
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.specialist',
          resourceId: 'auto-research',
          createdAt: 3
        }
      ]
    })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    const groupButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="tag-resource-group"]')
    )
    expect(groupButtons.map((button) => button.textContent?.trim())).toEqual([
      'Skills (1)',
      'Connectors (1)',
      'Specialists (1)'
    ])
    expect(groupButtons[0]?.querySelector('.lucide-scroll-text')).not.toBeNull()
    expect(groupButtons[1]?.querySelectorAll('rect')).toHaveLength(4)
    expect(groupButtons[2]?.querySelector('.lucide-users')).not.toBeNull()
    expect(groupButtons.every((button) => button.classList.contains('cursor-pointer'))).toBe(true)
    expect(groupButtons.every((button) => button.getAttribute('aria-expanded') === 'true')).toBe(
      true
    )
    expect(container.textContent).toContain('Analyze data')
    expect(container.textContent).toContain('Biomedical literature')
    expect(container.textContent).toContain('Research specialist')
    expect(
      Array.from(container.querySelectorAll('[data-slot="tag-resource-row"]')).map((row) =>
        row.textContent?.trim()
      )
    ).toEqual([
      'AnalysisAnalyze data',
      'PubMedBiomedical literature',
      'Auto ResearchResearch specialist'
    ])

    const groupSections = groupButtons.map((button) => button.closest('section'))
    expect(
      container.querySelector('[data-slot="tag-resource-groups"]')?.classList.contains('divide-y')
    ).toBe(true)
    expect(groupSections.every((section) => section?.classList.contains('py-3'))).toBe(true)
    expect(
      groupSections.every(
        (section) => !section?.querySelector('ul')?.classList.contains('divide-y')
      )
    ).toBe(true)

    act(() => groupButtons[0]?.click())
    expect(groupButtons[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('Analysis')
    expect(container.textContent).toContain('PubMed')
    expect(container.textContent).toContain('Auto Research')
  })

  it('aligns Tag counts and scopes management actions to the responsive detail view', async () => {
    useTagStore.setState({
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-research',
          name: 'Research',
          iconKey: 'book-open',
          colorKey: 'purple',
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    const tagRows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="tag-list-row"]')
    )
    const counts = tagRows.map((row) => row.querySelector('[data-slot="tag-list-count"]'))
    const masterDetail = container.querySelector('[data-slot="tag-master-detail"]')
    const tagList = masterDetail?.querySelector('aside')

    expect(tagRows).toHaveLength(2)
    expect(masterDetail?.classList.contains('grid-cols-1')).toBe(true)
    expect(masterDetail?.classList.contains('md:grid-cols-[220px_minmax(0,1fr)]')).toBe(true)
    expect(masterDetail?.classList.contains('min-h-0')).toBe(true)
    expect(tagList?.classList.contains('border-b')).toBe(true)
    expect(tagList?.classList.contains('bg-muted/20')).toBe(true)
    expect(tagList?.classList.contains('md:border-b-0')).toBe(true)
    expect(tagList?.classList.contains('md:border-r')).toBe(true)
    expect(tagRows.every((row) => row.classList.contains('flex-1'))).toBe(true)
    expect(counts.map((count) => count?.textContent)).toEqual(['1', '0'])
    expect(counts.every((count) => count?.classList.contains('ml-auto'))).toBe(true)
    expect(counts.every((count) => count?.classList.contains('min-w-5'))).toBe(true)
    expect(counts.every((count) => count?.classList.contains('text-right'))).toBe(true)
    expect(container.querySelector('[data-slot="tag-detail-actions"]')).toBeNull()
    expect(container.querySelector('[aria-label="Tag actions"]')).toBeNull()

    await act(async () => tagRows[1]?.click())

    const detailHeader = container.querySelector('[data-slot="tag-detail-header"]')
    const detailActions = container.querySelector('[data-slot="tag-detail-actions"]')
    expect(detailHeader?.classList.contains('flex-wrap')).toBe(true)
    expect(detailActions?.querySelector('[aria-label="Edit Tag"]')).not.toBeNull()
    expect(detailActions?.querySelector('[aria-label="Delete Tag"]')).not.toBeNull()
  })

  it('keeps the system Tag fixed and reorders custom Tags with the keyboard', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined)
    useTagStore.setState({
      reorder,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-a',
          name: 'Alpha',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'tag-b',
          name: 'Beta',
          iconKey: 'bookmark',
          colorKey: 'green',
          createdAt: 3,
          updatedAt: 3
        }
      ]
    })

    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    expect(container.querySelector('[aria-label="System Tags stay first"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Reorder Favorites"]')).toBeNull()
    const handle = container.querySelector<HTMLButtonElement>('[aria-label="Reorder Alpha"]')!
    handle.focus()
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(reorder).toHaveBeenCalledWith({ tagIds: ['tag-b', 'tag-a'] })
    expect(document.activeElement).toBe(handle)
    expect(container.textContent).toContain('Moved Alpha to position 3.')
  })

  it('keeps the first-position drop target stable while dragging upward', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined)
    useTagStore.setState({
      reorder,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-a',
          name: 'Alpha',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'tag-b',
          name: 'Beta',
          iconKey: 'bookmark',
          colorKey: 'green',
          createdAt: 3,
          updatedAt: 3
        }
      ]
    })
    await act(async () => {
      root.render(
        <TagsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} onOpenResource={vi.fn()} />
      )
    })

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-reorderable-tag-id]'))
    const firstBounds = vi.spyOn(rows[0]!, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 40,
      left: 0,
      right: 240,
      width: 240,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => undefined
    })
    vi.spyOn(rows[1]!, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 80,
      left: 0,
      right: 240,
      width: 240,
      height: 40,
      x: 0,
      y: 40,
      toJSON: () => undefined
    })
    const handle = container.querySelector<HTMLButtonElement>('[aria-label="Reorder Beta"]')!
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    handle.releasePointerCapture = vi.fn()

    dispatchPointer(handle, 'pointerdown', 70)
    dispatchPointer(handle, 'pointermove', 66)
    expect(rows[1]!.className).not.toContain('ring-primary/30')
    dispatchPointer(handle, 'pointermove', 0)
    expect(rows[1]!.className).toContain('ring-primary/30')
    expect(rows[0]!.querySelector('.-top-px')).not.toBeNull()
    expect(rows.every((row) => row.style.transform === '')).toBe(true)

    firstBounds.mockReturnValue({
      top: 40,
      bottom: 80,
      left: 0,
      right: 240,
      width: 240,
      height: 40,
      x: 0,
      y: 40,
      toJSON: () => undefined
    })
    dispatchPointer(handle, 'pointermove', 0)
    expect(rows[0]!.querySelector('.-top-px')).not.toBeNull()

    await act(async () => dispatchPointer(handle, 'pointerup', 0))
    expect(reorder).toHaveBeenCalledWith({ tagIds: ['tag-b', 'tag-a'] })
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
  })
})
