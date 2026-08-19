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
})
