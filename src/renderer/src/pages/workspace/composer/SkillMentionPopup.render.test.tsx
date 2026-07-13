// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillMentionPopup } from './SkillMentionPopup'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const seedSkills = [
  {
    id: 'lit',
    name: 'Literature Review',
    description: 'Find, verify, and synthesize scientific papers',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'mpnn',
    name: 'ProteinMPNN',
    description: 'Inverse-fold a protein backbone into sequence',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'imp',
    name: 'Imported Helper',
    description: 'A literature-adjacent skill from GitHub',
    source: 'imported' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: false
  }
]

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: seedSkills
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

const pressKey = (key: string): void => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('SkillMentionPopup', () => {
  it('filters by name or description and renders name, badge, and description', () => {
    act(() => {
      root.render(<SkillMentionPopup query="lit" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    // "lit" matches "Literature Review" by name and "Imported Helper" by description, not ProteinMPNN.
    const rendered = options()
    expect(rendered).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Literature Review')
    expect(text).toContain('Imported Helper')
    expect(text).not.toContain('ProteinMPNN')

    // Badge label + description are present for the matches.
    expect(text).toContain('Featured')
    expect(text).toContain('Imported')
    expect(text).toContain('Find, verify, and synthesize scientific papers')
  })

  it('shows every source when the query is empty', () => {
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options()).toHaveLength(3)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Featured')
    expect(text).toContain('Personal')
    expect(text).toContain('Imported')
  })

  it('moves aria-selected with ArrowDown/ArrowUp and wraps', () => {
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    const selectedIndex = (): number =>
      options().findIndex((option) => option.getAttribute('aria-selected') === 'true')

    // Starts on the first option.
    expect(selectedIndex()).toBe(0)

    pressKey('ArrowDown')
    expect(selectedIndex()).toBe(1)

    pressKey('ArrowDown')
    expect(selectedIndex()).toBe(2)

    // Wraps forward past the end.
    pressKey('ArrowDown')
    expect(selectedIndex()).toBe(0)

    // Wraps backward before the start.
    pressKey('ArrowUp')
    expect(selectedIndex()).toBe(2)
  })

  it('selects the active skill on Enter', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={onSelect} onClose={vi.fn()} />)
    })

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mpnn' }))
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={onClose} />)
    })

    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('selects a skill on click and sets it active on hover', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={onSelect} onClose={vi.fn()} />)
    })

    const third = options()[2]
    act(() => {
      // React synthesizes onMouseEnter from mouseover events at the root.
      third.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(third.getAttribute('aria-selected')).toBe('true')

    act(() => third.click())
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'imp' }))
  })
})
