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
    displayName: 'Literature Review',
    description: 'Find, verify, and synthesize scientific papers',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'mpnn',
    name: 'ProteinMPNN',
    displayName: 'ProteinMPNN',
    description: 'Inverse-fold a protein backbone into sequence',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'imp',
    name: 'Imported Helper',
    displayName: 'Imported Helper',
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

const pressKey = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    document.dispatchEvent(event)
  })
  return event
}

describe('SkillMentionPopup', () => {
  it('shows the exact Specialist scope and only Main-enabled Skills for Main', () => {
    act(() => {
      root.render(
        <SkillMentionPopup
          query=""
          allowedSkillIds={['lit']}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
    })
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('Literature Review')
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })
    expect(options()).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Imported Helper')
  })

  it('filters by name or description and renders name, badge, and description', () => {
    act(() => {
      root.render(
        <SkillMentionPopup
          query="lit"
          allowedSkillIds={seedSkills.map((skill) => skill.id)}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
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

  it('omits Main-disabled sources when the query is empty', () => {
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options()).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Featured')
    expect(text).toContain('Personal')
    expect(text).not.toContain('Imported')
  })

  it('keeps the shortcut footer outside the scrollable skill list', () => {
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')!
    const popup = listbox.parentElement!
    const footer = popup.lastElementChild as HTMLElement

    expect([...popup.classList]).toEqual(expect.arrayContaining(['flex', 'flex-col']))
    expect([...listbox.classList]).toEqual(expect.arrayContaining(['min-h-0', 'flex-1']))
    expect(footer.classList).toContain('shrink-0')
  })

  it('moves aria-selected with ArrowDown/ArrowUp and wraps', () => {
    act(() => {
      root.render(
        <SkillMentionPopup
          query=""
          allowedSkillIds={seedSkills.map((skill) => skill.id)}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
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
      root.render(
        <SkillMentionPopup
          query=""
          allowedSkillIds={seedSkills.map((skill) => skill.id)}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      )
    })

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mpnn' }))
  })

  it('selects the active skill on plain Tab but preserves Shift+Tab navigation', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SkillMentionPopup query="" onSelect={onSelect} onClose={vi.fn()} />)
    })

    pressKey('ArrowDown')
    const tabEvent = pressKey('Tab')
    const shiftTabEvent = pressKey('Tab', { shiftKey: true })

    expect(tabEvent.defaultPrevented).toBe(true)
    expect(shiftTabEvent.defaultPrevented).toBe(false)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mpnn' }))
    expect(document.body.textContent).toContain('Enter / Tab select')
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
      root.render(
        <SkillMentionPopup
          query=""
          allowedSkillIds={seedSkills.map((skill) => skill.id)}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      )
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

  it('ranks a name match above a description-only match', () => {
    act(() => {
      root.render(
        <SkillMentionPopup
          query="literature"
          allowedSkillIds={seedSkills.map((skill) => skill.id)}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
    })

    // "literature" hits Literature Review by name and Imported Helper only by description.
    const rendered = options()
    expect(rendered).toHaveLength(2)
    expect(rendered[0].textContent).toContain('Literature Review')
    expect(rendered[1].textContent).toContain('Imported Helper')
  })

  it('matches a fuzzy subsequence that a plain substring would miss', () => {
    act(() => {
      root.render(<SkillMentionPopup query="pmpnn" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    // "pmpnn" is not a substring of "ProteinMPNN" but is an ordered subsequence of it.
    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(rendered[0].textContent).toContain('ProteinMPNN')
  })

  it('highlights the matched characters in the name', () => {
    act(() => {
      root.render(<SkillMentionPopup query="lit" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    // The name match renders the matched run inside a <mark>; description-only matches do not.
    const marks = Array.from(document.body.querySelectorAll('mark'))
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent?.toLowerCase()).toBe('lit')
  })
})
