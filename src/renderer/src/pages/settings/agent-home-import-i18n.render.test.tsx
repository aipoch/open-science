// @vitest-environment jsdom
// Covers the three things in this view that a plain string swap gets wrong: the skill count is a
// plural (en has _one/_other, zh only _other), the scan sentence exists in one- and two-path variants
// rather than splicing " and <path>" into translated prose, and the source badge mixes a translated
// label ("Shared") with product names that must stay in English.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { AgentHomeImportView } from './AgentHomeImportView'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const skill = (slug: string, source: string, alreadyImported = false): unknown => ({
  slug,
  name: slug,
  description: `${slug} description`,
  source,
  alreadyImported
})

const setup = (skills: unknown[], frameworkId: string): void => {
  useSettingsStore.setState({
    agentFrameworkId: frameworkId,
    listAgentHomeSkills: vi.fn().mockResolvedValue(skills),
    importAgentHomeSkills: vi.fn().mockResolvedValue({ imported: 0 }),
    previewAgentHomeSkill: vi.fn().mockResolvedValue(null)
  } as never)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('AgentHomeImportView copy', () => {
  it('selects the plural form for the skill count in each language', async () => {
    setup([skill('alpha', 'agents')], 'claude-code')
    act(() => {
      root.render(<AgentHomeImportView onImported={vi.fn()} />)
    })
    await flush()
    // en has a dedicated _one form.
    expect(container.textContent).toContain('1 skill found')
    expect(container.textContent).not.toContain('1 skills found')

    // zh has no singular/plural distinction — one _other form covers both counts.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('找到 1 個 Skill')
    switchTo('zh-Hans')
    expect(container.textContent).toContain('找到 1 个 Skill')
  })

  it('uses the plural form for counts above one', async () => {
    setup([skill('alpha', 'agents'), skill('beta', 'claude')], 'claude-code')
    act(() => {
      root.render(<AgentHomeImportView onImported={vi.fn()} />)
    })
    await flush()
    expect(container.textContent).toContain('2 skills found')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('找到 2 个 Skill')
  })

  it('swaps whole scan sentences instead of splicing the second path in', async () => {
    setup([], 'claude-code')
    act(() => {
      root.render(<AgentHomeImportView onImported={vi.fn()} />)
    })
    await flush()
    // Both paths render as <code>, and paths are never translated.
    const paths = (): string[] =>
      [...container.querySelectorAll('code')].map((node) => node.textContent ?? '')
    expect(paths()).toEqual(['~/.agents/skills', '~/.claude/skills'])

    switchTo('zh-Hant')
    expect(paths()).toEqual(['~/.agents/skills', '~/.claude/skills'])
    expect(container.textContent).toContain('掃描這台電腦上的')
    // The English connector must be gone, not left stranded between the two paths.
    expect(container.textContent).not.toContain(' and ')
  })

  it('falls back to the one-path sentence when no framework folder applies', async () => {
    setup([], 'opencode')
    act(() => {
      root.render(<AgentHomeImportView onImported={vi.fn()} />)
    })
    await flush()
    expect([...container.querySelectorAll('code')].map((n) => n.textContent)).toEqual([
      '~/.agents/skills'
    ])
    // No dangling "and" and no literal "undefined" from the unused interpolation value.
    expect(container.textContent).not.toContain('undefined')
  })

  it('translates the Shared badge but leaves product-name badges in English', async () => {
    setup([skill('alpha', 'agents'), skill('beta', 'claude')], 'claude-code')
    act(() => {
      root.render(<AgentHomeImportView onImported={vi.fn()} />)
    })
    await flush()
    expect(container.textContent).toContain('Shared')
    expect(container.textContent).toContain('Claude Code')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('共用')
    expect(container.textContent).not.toContain('Shared')
    // Product name is not translated.
    expect(container.textContent).toContain('Claude Code')
  })
})
