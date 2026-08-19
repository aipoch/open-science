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
})

describe('TagsPanel', () => {
  it('aggregates tagged resources and opens their owning Settings detail', async () => {
    const onOpenResource = vi.fn()
    await act(async () => {
      root.render(<TagsPanel onOpenResource={onOpenResource} />)
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
      subtitle: 'Skill'
    })
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
      root.render(<TagsPanel onOpenResource={vi.fn()} />)
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
      root.render(<TagsPanel onOpenResource={vi.fn()} />)
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

    act(() => groupButtons[0]?.click())
    expect(groupButtons[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('Analysis')
    expect(container.textContent).toContain('PubMed')
    expect(container.textContent).toContain('Auto Research')
  })

  it('reveals custom Tag actions on row hover or keyboard focus', async () => {
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
      root.render(<TagsPanel onOpenResource={vi.fn()} />)
    })

    const actions = container.querySelector<HTMLButtonElement>('[aria-label="Tag actions"]')
    const selectedTag = container.querySelector<HTMLButtonElement>('aside [aria-current="page"]')
    expect(selectedTag?.className).toContain('cursor-pointer')
    expect(actions?.className).toContain('sm:opacity-0')
    expect(actions?.className).toContain('sm:group-hover:opacity-100')
    expect(actions?.className).toContain('focus-visible:opacity-100')
    expect(actions?.className).toContain('data-[state=open]:opacity-100')
  })
})
