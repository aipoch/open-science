// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillDetailView } from './SkillDetailView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'

let container: HTMLDivElement
let root: Root

const detail = {
  id: 'a',
  name: 'Alpha',
  displayName: 'Alpha',
  description: 'First skill description.',
  source: 'featured' as const,
  updatedAt: '2026-07-08T00:00:00.000Z',
  enabled: true,
  author: 'Test Author',
  license: 'Test License',
  thirdParty: 'Weights — Example (CC-BY-4.0)',
  body: '# Alpha body'
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    settings: { getSkillDetail: vi.fn().mockResolvedValue(detail) }
  }
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [
      {
        id: 'a',
        name: 'Alpha',
        displayName: 'Alpha',
        description: 'First skill description.',
        source: 'featured',
        updatedAt: '2026-07-08T00:00:00.000Z',
        enabled: true
      }
    ],
    setSkillEnabled: vi.fn().mockResolvedValue(undefined)
  })
  useSpecialistStore.setState({
    items: [
      {
        kind: 'custom',
        id: 'literature-reviewer',
        name: 'LITERATURE_REVIEWER',
        displayName: 'Literature Reviewer',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: ['a'], connectorIds: [], connectorTools: [] },
        revision: 1
      }
    ],
    isLoaded: true,
    load: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillDetailView', () => {
  it('renders the header, Files body, and Details metadata from the frontmatter', async () => {
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })
    // Let the getSkillDetail promise resolve and re-render with the body + metadata.
    await act(async () => {
      await Promise.resolve()
    })

    // Header: name + description below it.
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('First skill description.')
    expect(document.body.textContent).toContain('Availability')
    expect(document.body.textContent).toContain('Shared with Main')
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="skill-usage-agents-trigger"]')
        ?.focus()
    )
    expect(
      document.body.querySelector('[data-slot="skill-usage-agents-popover"]')?.textContent
    ).toContain('Literature Reviewer')

    // Files section renders the SKILL.md body.
    expect(document.body.textContent).toContain('Files')
    expect(document.body.textContent).toContain('Alpha body')

    // Details section surfaces frontmatter author + license + third-party info.
    expect(document.body.textContent).toContain('Details')
    expect(document.body.textContent).toContain('Author')
    expect(document.body.textContent).toContain('Test Author')
    expect(document.body.textContent).toContain('License')
    expect(document.body.textContent).toContain('Test License')
    expect(document.body.textContent).toContain(
      'Third-party software, content, terms, and information'
    )
    expect(document.body.textContent).toContain('Weights — Example (CC-BY-4.0)')
  })

  it('renders generic persisted metadata without duplicating dedicated detail rows', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          metadata: {
            author: 'Duplicate author',
            license: 'Duplicate license',
            'third-party': 'Duplicate third-party notice',
            category: 'Biology',
            custom_key: 'Custom value'
          }
        })
      }
    }

    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Category')
    expect(document.body.textContent).toContain('Biology')
    expect(document.body.textContent).toContain('Custom Key')
    expect(document.body.textContent).toContain('Custom value')
    expect(document.body.textContent).not.toContain('Duplicate author')
    expect(document.body.textContent).not.toContain('Duplicate license')
    expect(document.body.textContent).not.toContain('Duplicate third-party notice')
  })

  it('labels the badge by the skill source, not always "Featured"', async () => {
    for (const [source, label] of [
      ['featured', 'Featured'],
      ['imported', 'Imported'],
      ['personal', 'Personal']
    ] as const) {
      ;(window as unknown as { api: unknown }).api = {
        settings: { getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source }) }
      }
      useSettingsStore.setState({
        ...createInitialSettingsState(),
        skills: [
          {
            id: 'a',
            name: 'Alpha',
            displayName: 'Alpha',
            description: 'First skill description.',
            source,
            updatedAt: detail.updatedAt,
            enabled: true
          }
        ],
        setSkillEnabled: vi.fn().mockResolvedValue(undefined)
      })

      const localContainer = document.createElement('div')
      document.body.appendChild(localContainer)
      const localRoot = createRoot(localContainer)
      await act(async () => {
        localRoot.render(<SkillDetailView skillId="a" />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const badge = localContainer.querySelector('span.rounded-full')
      expect(badge?.textContent).toBe(label)

      act(() => localRoot.unmount())
      localContainer.remove()
    }
  })

  it('toggles the skill from the detail header switch', async () => {
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })

    const toggle = document.body.querySelector<HTMLButtonElement>('[role="switch"]')
    act(() => toggle?.click())

    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('a', false)
  })

  it('omits the agent access row when no agent uses the Skill', async () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      skills: [
        {
          id: 'a',
          name: 'Alpha',
          displayName: 'Alpha',
          description: 'First skill description.',
          source: 'featured',
          updatedAt: detail.updatedAt,
          enabled: false
        }
      ],
      setSkillEnabled: vi.fn().mockResolvedValue(undefined)
    })
    useSpecialistStore.setState({ items: [], isLoaded: true })

    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Agents with access')
    expect(document.body.querySelector('[data-slot="skill-usage-agents-trigger"]')).toBeNull()
  })

  it('shows a retryable error when Skill detail loading fails', async () => {
    const getSkillDetail = window.api.settings.getSkillDetail as ReturnType<typeof vi.fn>
    getSkillDetail
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValueOnce(detail)

    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Open Science could not load this Skill.'
    )
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })
    expect(getSkillDetail).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Alpha body')
  })

  it('reports a rejected Skill access change after rollback', async () => {
    useSettingsStore.setState({
      setSkillEnabled: vi.fn().mockRejectedValue(new Error('write failed'))
    })
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
      await Promise.resolve()
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[role="switch"]')?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save this setting. The previous value was restored.'
    )
  })
})
