import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleAlert,
  LoaderCircle,
  PackageOpen,
  RotateCw,
  SearchX,
  SquareTerminal
} from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { SkillSource, SkillView } from '../../../../../shared/settings'
import type { Wsl2BashPreviewStatus } from '../../../../../shared/wsl-setup'
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
  composingRef?: React.RefObject<boolean>
  allowedSkillIds?: readonly string[]
  listboxId?: string
  onActiveOptionIdChange?: (optionId: string | undefined) => void
  onSelect: (skill: SkillView) => void
  onSelectWslSetup?: () => void
  onClose: () => void
}

// Catalog key for the badge label per skill source. `as const` keeps the values literal so the t()
// lookup in the row stays compile-time checked.
const SOURCE_LABEL_KEYS = {
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
} as const satisfies Record<SkillSource, string>

export const SkillMentionPopup = ({
  query,
  composingRef,
  allowedSkillIds,
  listboxId,
  onActiveOptionIdChange,
  onSelect,
  onSelectWslSetup,
  onClose
}: SkillMentionPopupProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const skills = useSettingsStore((state) => state.skills)
  const skillsLoaded = useSettingsStore((state) => state.skillsLoaded)
  const [loadError, setLoadError] = useState(false)
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [wslStatus, setWslStatus] = useState<Wsl2BashPreviewStatus>()
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const generatedListboxId = useId()
  const resolvedListboxId = listboxId ?? generatedListboxId

  // Catalog ownership stays in the store; only this popup's retry feedback is local.
  useEffect(() => {
    if (skillsLoaded || skills.length > 0) return
    let cancelled = false
    void loadSkills().catch(() => {
      if (!cancelled) setLoadError(true)
    })
    return () => {
      cancelled = true
    }
  }, [skillsLoaded, skills.length, loadSkills, retryAttempt])

  useEffect(() => {
    const getStatus = window.api?.settings?.getWsl2BashPreviewStatus
    if (!getStatus) return
    let active = true
    void getStatus()
      .then((status) => {
        if (active) setWslStatus(status)
      })
      .catch(() => {
        if (active) setWslStatus({ available: false, reason: 'not-initialized' })
      })
    return () => {
      active = false
    }
  }, [])

  const visibleSkills = useMemo(() => {
    const allowed = allowedSkillIds ? new Set(allowedSkillIds) : undefined
    return skills.filter(
      (skill) => skill.available !== false && (allowed ? allowed.has(skill.id) : skill.enabled)
    )
  }, [skills, allowedSkillIds])

  // Rank the query best-first: fuzzy subsequence against the name (so "cg" finds "clinical-genomics"),
  // falling back to a plain substring in the description. Names always outrank description-only hits;
  // descriptions stay a contiguous "contains" test since scattered matches across prose are noise.
  // Empty query shows every skill in its original order.
  const matches = useMemo<SkillMatch[]>(() => {
    const needle = query.trim()
    if (needle.length === 0) return visibleSkills.map((skill) => ({ skill, positions: [] }))

    const descNeedle = needle.toLowerCase()
    return (
      visibleSkills
        .map((skill) => {
          const nameMatch = fuzzyScore(needle, skill.displayName)
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
  }, [visibleSkills, query])

  const productCommandMatches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (
      onSelectWslSetup !== undefined &&
      (needle.length === 0 ||
        '/setup-wsl'.includes(needle) ||
        'set up or repair wsl2 bash'.includes(needle))
    )
  }, [onSelectWslSetup, query])
  const optionCount = matches.length + (productCommandMatches ? 1 : 0)

  const [activeIndex, setActiveIndex] = useState(0)

  // Reset the highlight to the top when the query changes. This is the setState-during-render pattern
  // React recommends over a synchronizing effect for deriving state from a changing prop.
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  // Keep the highlight within the current match set even after filtering shrinks it.
  const safeIndex = optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1)
  const activeOptionId = optionCount > 0 ? `${resolvedListboxId}-option-${safeIndex}` : undefined

  // Focus remains in the editor, so keep its active-descendant target synchronized and visible.
  useEffect(() => {
    onActiveOptionIdChange?.(activeOptionId)
    return () => onActiveOptionIdChange?.(undefined)
  }, [activeOptionId, onActiveOptionIdChange])

  useEffect(() => {
    if (activeOptionId)
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])

  // Handle navigation keys at the document level while mounted, since focus stays in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || composingRef?.current) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (optionCount > 0) setActiveIndex((safeIndex + 1) % optionCount)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (optionCount > 0) setActiveIndex((safeIndex - 1 + optionCount) % optionCount)
      } else if (
        event.key === 'Enter' ||
        (event.key === 'Tab' &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey)
      ) {
        if (productCommandMatches && safeIndex === 0 && wslStatus?.available !== false) {
          event.preventDefault()
          onSelectWslSetup?.()
        } else {
          const active = matches[safeIndex - (productCommandMatches ? 1 : 0)]
          if (active) {
            event.preventDefault()
            onSelect(active.skill)
          }
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    matches,
    optionCount,
    productCommandMatches,
    safeIndex,
    onSelect,
    onSelectWslSetup,
    onClose,
    composingRef,
    wslStatus
  ])

  const loading = skills.length === 0 && !skillsLoaded && !loadError
  const failed = skills.length === 0 && !skillsLoaded && loadError
  const StatusIcon = loading
    ? LoaderCircle
    : failed
      ? CircleAlert
      : visibleSkills.length === 0
        ? PackageOpen
        : SearchX

  return (
    <div className="absolute bottom-full left-0 mb-1 z-50 flex flex-col bg-bg-000 border-0.5 border-border-200 rounded-xl shadow-[0_4px_16px_hsl(var(--always-black)/10%)] p-1.5 w-max min-w-[min(320px,100%)] max-w-[min(440px,100%)] max-h-[min(45vh,18rem)] overflow-hidden">
      <ul
        id={resolvedListboxId}
        role="listbox"
        aria-label={t('Skill suggestions')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {optionCount === 0 && (
          <li role="presentation" className="flex min-h-18 items-center gap-3 px-3 py-3.5">
            <span
              aria-hidden="true"
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${failed ? 'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground' : 'bg-bg-200 text-text-100'}`}
            >
              <StatusIcon
                className={`size-4${loading ? ' animate-spin motion-reduce:animate-none' : ''}`}
              />
            </span>
            <div
              role={failed ? 'alert' : 'status'}
              className="min-w-0 flex-1 text-sm font-medium leading-5 text-text-000"
            >
              {loading
                ? t('Loading skills…')
                : failed
                  ? t('Could not load skills')
                  : visibleSkills.length === 0
                    ? t('No skills available')
                    : t('No matching skills')}
            </div>
            {failed && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setLoadError(false)
                  setRetryAttempt((attempt) => attempt + 1)
                }}
              >
                <RotateCw aria-hidden="true" />
                {t('Retry')}
              </Button>
            )}
          </li>
        )}
        {productCommandMatches ? (
          <li
            id={`${resolvedListboxId}-option-0`}
            role="option"
            aria-selected={safeIndex === 0}
            aria-disabled={wslStatus?.available === false}
            data-testid="product-command-setup-wsl"
            onMouseEnter={() => setActiveIndex(0)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (wslStatus?.available !== false) onSelectWslSetup?.()
            }}
            className={`w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-text-100 transition-colors hover:bg-bg-200 hover:text-text-000 ${wslStatus?.available === false ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}${safeIndex === 0 ? ' bg-bg-200 !text-text-000' : ''}`}
          >
            <SquareTerminal className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">/setup-wsl</span>
                <span className="ml-auto rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
                  {t('Open Science')}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-text-300">
                {wslStatus && !wslStatus.available
                  ? t('WSL2 setup is unavailable on this system ({{reason}}).', {
                      reason: wslStatus.reason
                    })
                  : t('Set up or repair WSL2 Bash in a guided conversation')}
              </div>
            </div>
          </li>
        ) : null}
        {matches.map(({ skill, positions }, index) => {
          const optionIndex = index + (productCommandMatches ? 1 : 0)
          const isActive = optionIndex === safeIndex
          return (
            <li
              key={skill.id}
              id={`${resolvedListboxId}-option-${optionIndex}`}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => setActiveIndex(optionIndex)}
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
                    <HighlightedText text={skill.displayName} positions={positions} />
                  </span>
                  <div className="flex-1" />
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground">
                    {t(SOURCE_LABEL_KEYS[skill.source])}
                  </span>
                </div>
                <div className="text-xs text-text-300 line-clamp-2 mt-0.5">{skill.description}</div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-1 -mx-1.5 -mb-1.5 flex shrink-0 items-center justify-end gap-3 border-t border-border-200 bg-bg-200/40 px-3 py-1.5 text-[11px] text-text-100 select-none">
        {optionCount > 0 && (
          <>
            <span>
              <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
                ↑↓
              </kbd>{' '}
              {t('navigate')}
            </span>
            <span>
              <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
                Enter / Tab
              </kbd>{' '}
              {t('select')}
            </span>
          </>
        )}
        <span>
          <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
            Esc
          </kbd>{' '}
          {t('close')}
        </span>
      </div>
    </div>
  )
}
