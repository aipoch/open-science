import { useEffect, useId, useMemo, useState } from 'react'

import type { SkillSource, SkillView } from '../../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'

import { fuzzyScore } from './fuzzy-match'
import { HighlightedText } from './HighlightedText'

// A skill plus the name-match positions to highlight (empty when it matched on description only).
type SkillMatch = { skill: SkillView; positions: number[] }

// Match tiers: any name hit ranks strictly above any description-only hit, decided before score.
// A tier (not an additive weight) is required because a long, gappy fuzzy name score can go negative.
const TIER_NAME = 1
const TIER_DESCRIPTION = 0

// Popup that suggests skills for the composer's `/` mention trigger. The composer keeps focus in its
// editor, so this listens for navigation keys on document while mounted rather than owning focus.
type SkillMentionPopupProps = {
  query: string
  onSelect: (skill: SkillView) => void
  onClose: () => void
}

// Human-readable badge label per skill source.
const SOURCE_LABELS: Record<SkillSource, string> = {
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
}

export const SkillMentionPopup = ({
  query,
  onSelect,
  onClose
}: SkillMentionPopupProps): React.JSX.Element | null => {
  const skills = useSettingsStore((state) => state.skills)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const listboxId = useId()

  // The skill list is loaded lazily by the Settings panel; the composer may open before that ever ran,
  // so hydrate it here when empty. Cheap and idempotent — the store keeps the result after the first load.
  useEffect(() => {
    if (skills.length === 0) void loadSkills()
  }, [skills.length, loadSkills])

  // Rank the query best-first: fuzzy subsequence against the name (so "cg" finds "clinical-genomics"),
  // falling back to a plain substring in the description. Names always outrank description-only hits;
  // descriptions stay a contiguous "contains" test since scattered matches across prose are noise.
  // Empty query shows every skill in its original order.
  const matches = useMemo<SkillMatch[]>(() => {
    const needle = query.trim()
    if (needle.length === 0) return skills.map((skill) => ({ skill, positions: [] }))

    const descNeedle = needle.toLowerCase()
    return (
      skills
        .map((skill) => {
          const nameMatch = fuzzyScore(needle, skill.name)
          if (nameMatch) {
            return {
              skill,
              tier: TIER_NAME,
              score: nameMatch.score,
              positions: nameMatch.positions
            }
          }
          if (skill.description.toLowerCase().includes(descNeedle)) {
            return { skill, tier: TIER_DESCRIPTION, score: 0, positions: [] }
          }
          return null
        })
        .filter((m): m is SkillMatch & { tier: number; score: number } => m !== null)
        // Tier first (name always beats description-only), then fuzzy score within a tier.
        .sort((a, b) => b.tier - a.tier || b.score - a.score)
        .map(({ skill, positions }) => ({ skill, positions }))
    )
  }, [skills, query])

  const [activeIndex, setActiveIndex] = useState(0)

  // Reset the highlight to the top when the query changes. This is the setState-during-render pattern
  // React recommends over a synchronizing effect for deriving state from a changing prop.
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  // Keep the highlight within the current match set even after filtering shrinks it.
  const safeIndex = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1)

  // Handle navigation keys at the document level while mounted, since focus stays in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex - 1 + matches.length) % matches.length)
      } else if (event.key === 'Enter') {
        const active = matches[safeIndex]
        if (active) {
          event.preventDefault()
          onSelect(active.skill)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [matches, safeIndex, onSelect, onClose])

  return (
    <div className="absolute bottom-full left-0 mb-1 z-50 bg-bg-000 border-0.5 border-border-200 rounded-xl shadow-[0_4px_16px_hsl(var(--always-black)/10%)] p-1.5 min-w-[320px] max-w-[440px] max-h-[min(45vh,18rem)] overflow-hidden">
      <ul
        id={`${listboxId}-listbox`}
        role="listbox"
        aria-label="Skill suggestions"
        className="overflow-y-auto max-h-[min(45vh,18rem)]"
      >
        {matches.map(({ skill, positions }, index) => {
          const isActive = index === safeIndex
          return (
            <li
              key={skill.id}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => setActiveIndex(index)}
              // Keep the editor focused/caret intact so the mention stays open long enough for the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(skill)}
              className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-sm text-text-100 hover:bg-bg-200 hover:text-text-000 transition-colors cursor-pointer${
                isActive ? ' bg-bg-200 !text-text-000' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm">
                    <HighlightedText text={skill.name} positions={positions} />
                  </span>
                  <div className="flex-1" />
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground">
                    {SOURCE_LABELS[skill.source]}
                  </span>
                </div>
                <div className="text-xs text-text-300 line-clamp-2 mt-0.5">{skill.description}</div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-1 -mx-1.5 -mb-1.5 px-3.5 pt-1.5 pb-2 border-t border-border-300 flex items-center gap-3 text-[11px] text-text-400 select-none">
        <span>
          <span className="text-text-300">↑↓</span> navigate
        </span>
        <span>
          <span className="text-text-300">Enter</span> select
        </span>
        <span>
          <span className="text-text-300">Esc</span> close
        </span>
      </div>
    </div>
  )
}
