import { Check, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { SpecialistAvatar } from '../settings/specialist-avatar'

type RunnableSpecialistItem = Exclude<SpecialistListItem, { kind: 'reviewer' }>

type ComposerSpecialistPickerProps = {
  selectedId: string | undefined
  readOnly?: boolean
  onChange: (specialistId: string | undefined) => void
}

type PickerOption = {
  key: string
  id: string | undefined
  name: string
  searchText: string
  specialist?: RunnableSpecialistItem
}

const ComposerSpecialistPicker = ({
  selectedId,
  readOnly = false,
  onChange
}: ComposerSpecialistPickerProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const isLoaded = useSpecialistStore((state) => state.isLoaded)
  const load = useSpecialistStore((state) => state.load)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()

  useEffect(() => {
    if (open && !isLoaded && typeof window.api?.specialist?.list === 'function') {
      void load()
    }
  }, [isLoaded, load, open])

  useEffect(() => {
    if (typeof window.api?.specialist?.onCatalogChanged !== 'function') return
    return window.api.specialist.onCatalogChanged(() => {
      void load()
    })
  }, [load])

  if (!selectedId) return null

  const selected = items.find(
    (item): item is RunnableSpecialistItem => item.kind !== 'reviewer' && item.id === selectedId
  )
  const selectedName = selected ? (selected.displayName ?? selected.name) : t('Unavailable')
  const enabledSpecialists = items.filter(
    (item): item is RunnableSpecialistItem => item.kind !== 'reviewer' && item.enabled
  )
  const options: PickerOption[] = [
    {
      key: '__main-agent-option',
      id: undefined,
      name: t('Main Agent'),
      searchText: t('Main Agent')
    },
    ...enabledSpecialists.map((specialist) => ({
      key: specialist.id,
      id: specialist.id,
      name: specialist.displayName ?? specialist.name,
      searchText: `${specialist.displayName ?? ''} ${specialist.name} ${specialist.description}`,
      specialist
    }))
  ]
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredOptions = normalizedQuery
    ? options.filter((option) => option.searchText.toLocaleLowerCase().includes(normalizedQuery))
    : options
  const safeActiveIndex = Math.min(activeIndex, Math.max(filteredOptions.length - 1, 0))
  const activeOption = filteredOptions[safeActiveIndex]

  const chooseOption = (option: PickerOption): void => {
    onChange(option.id)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setQuery('')
          const selectedIndex = options.findIndex((option) => option.id === selectedId)
          setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={readOnly}
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 transition-colors before:absolute before:content-[''] hover:bg-bg-200 hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:before:-inset-y-1.5 [@media(pointer:coarse)]:before:inset-x-0"
          aria-label={t('Choose Specialist: {{name}}', { name: selectedName })}
          data-testid="composer-specialist-picker-trigger"
        >
          {selected ? (
            <SpecialistAvatar iconKey={selected.iconKey} colorKey={selected.colorKey} />
          ) : (
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-bg-300 text-[11px]"
              aria-hidden="true"
            >
              —
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-[min(16rem,calc(100vw-1rem))] rounded-xl border border-border-200 bg-bg-000 p-1.5 text-text-000 shadow-menu"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-text-300">
          {t('Choose Specialist')}
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-300"
            strokeWidth={2}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (filteredOptions.length === 0) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((safeActiveIndex + 1) % filteredOptions.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(
                  (safeActiveIndex - 1 + filteredOptions.length) % filteredOptions.length
                )
              } else if (event.key === 'Home') {
                event.preventDefault()
                setActiveIndex(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                setActiveIndex(filteredOptions.length - 1)
              } else if (event.key === 'Enter' && activeOption) {
                event.preventDefault()
                chooseOption(activeOption)
              }
            }}
            placeholder={t('Search specialists…')}
            aria-label={t('Search specialists')}
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeOption ? `${listboxId}-${activeOption.key}` : undefined}
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-input bg-bg-000 pr-2 pl-8 text-[13px] text-text-000 outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/20 [@media(pointer:coarse)]:h-11"
          />
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('Choose Specialist')}
          className="mt-1 max-h-[min(45vh,18rem)] overflow-y-auto overscroll-contain"
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option, index) => {
              const isActive = index === safeActiveIndex
              const isSelected = option.id === selectedId
              return (
                <button
                  key={option.key}
                  id={`${listboxId}-${option.key}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    'flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-text-100 outline-none [@media(pointer:coarse)]:min-h-11',
                    isActive && 'bg-bg-200 text-text-000'
                  )}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => chooseOption(option)}
                  data-testid={`composer-specialist-option-${option.key}`}
                >
                  {option.specialist ? (
                    <SpecialistAvatar
                      iconKey={option.specialist.iconKey}
                      colorKey={option.specialist.colorKey}
                    />
                  ) : (
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-bg-300 text-[11px]"
                      aria-hidden="true"
                    >
                      —
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {isSelected ? (
                    <Check
                      className="size-4 shrink-0 text-primary"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              )
            })
          ) : (
            <div role="status" className="px-2 py-5 text-center text-[12px] text-text-300">
              {t('No Specialists match “{{query}}”.', { query: query.trim() })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { ComposerSpecialistPicker }
