/* Hallmark · component: editable number combobox · genre: modern-minimal · theme: Open Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: uses the project semantic foreground, muted, ring, destructive, and success tokens
 * pre-emit critique: P5 H5 E5 S5 R5 V5
 */
import * as React from 'react'
import { AlertCircle, Check, ChevronDown, Loader2 } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type EditableNumberComboboxPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type EditableNumberComboboxStatus = 'idle' | 'loading' | 'error' | 'success'

type EditableNumberComboboxProps = {
  id: string
  ariaLabel: string
  value: string
  presets: readonly number[]
  onValueChange: (value: string) => void
  locale?: string
  placeholder?: string
  disabled?: boolean
  status?: EditableNumberComboboxStatus
  describedBy?: string
  previewState?: EditableNumberComboboxPreviewState
}

const previewStateClassName: Record<EditableNumberComboboxPreviewState, string> = {
  default: '',
  hover: 'bg-muted/60',
  focus: 'border-ring outline-2 outline-offset-1 outline-ring/50',
  active: 'translate-y-px bg-muted/80',
  disabled: 'cursor-not-allowed opacity-50',
  loading: 'cursor-wait',
  error: 'border-destructive outline-2 outline-offset-1 outline-destructive/20',
  success:
    'border-status-success-accent outline-2 outline-offset-1 outline-status-success-accent/20'
}

const EditableNumberCombobox = ({
  id,
  ariaLabel,
  value,
  presets,
  onValueChange,
  locale,
  placeholder,
  disabled = false,
  status = 'idle',
  describedBy,
  previewState
}: EditableNumberComboboxProps): React.JSX.Element => {
  const listboxId = React.useId()
  const anchorRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const [anchorWidth, setAnchorWidth] = React.useState<number>()
  const formatter = React.useMemo(() => new Intl.NumberFormat(locale), [locale])
  const visualState = previewState ?? (status === 'idle' ? 'default' : status)
  const interactionDisabled = disabled || visualState === 'disabled'
  const popupOpen = open && !interactionDisabled
  const invalid = visualState === 'error'
  const selectedIndex = presets.findIndex((preset) => String(preset) === value)

  const openWithIndex = (index: number): void => {
    if (interactionDisabled) return
    setAnchorWidth(anchorRef.current?.getBoundingClientRect().width)
    setOpen(true)
    setActiveIndex(index)
  }

  const selectPreset = (preset: number): void => {
    onValueChange(String(preset))
    setOpen(false)
    setActiveIndex(-1)
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (interactionDisabled) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = open ? Math.min(activeIndex + 1, presets.length - 1) : Math.max(selectedIndex, 0)
      openWithIndex(next)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = open
        ? activeIndex <= 0
          ? presets.length - 1
          : activeIndex - 1
        : selectedIndex >= 0
          ? selectedIndex
          : presets.length - 1
      openWithIndex(next)
      return
    }

    if (event.key === 'Enter' && open && activeIndex >= 0) {
      event.preventDefault()
      const preset = presets[activeIndex]
      if (preset !== undefined) selectPreset(preset)
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <Popover
      open={popupOpen}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setActiveIndex(-1)
      }}
    >
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          data-slot="editable-number-combobox"
          data-visual-state={visualState}
          className={cn(
            'flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-transparent text-foreground outline-2 outline-offset-1 outline-transparent transition-colors duration-150 motion-reduce:transition-none focus-within:border-ring focus-within:outline-ring/50 active:bg-muted/80 [@media(hover:hover)]:hover:bg-muted/60 [@media(pointer:coarse)]:h-11',
            interactionDisabled && 'cursor-not-allowed bg-input/50 opacity-50',
            invalid && 'border-destructive outline-destructive/20',
            visualState === 'success' &&
              'border-status-success-accent outline-status-success-accent/20',
            previewStateClassName[visualState]
          )}
        >
          <Input
            ref={inputRef}
            id={id}
            aria-label={ariaLabel}
            aria-autocomplete="none"
            aria-controls={listboxId}
            aria-describedby={describedBy}
            aria-expanded={popupOpen}
            aria-haspopup="listbox"
            aria-activedescendant={
              popupOpen && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
            }
            aria-invalid={invalid || undefined}
            aria-busy={visualState === 'loading' || undefined}
            role="combobox"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={value}
            disabled={interactionDisabled}
            placeholder={placeholder}
            onChange={(event) => {
              onValueChange(event.target.value)
              setActiveIndex(-1)
            }}
            onKeyDown={handleKeyDown}
            className="h-full flex-1 rounded-e-none border-0 bg-transparent py-1 pe-1 font-normal tabular-nums shadow-none ring-0 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-expanded={popupOpen}
            disabled={interactionDisabled}
            onMouseDown={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
            }}
            onClick={() => {
              if (open) {
                setOpen(false)
                setActiveIndex(-1)
              } else {
                openWithIndex(Math.max(selectedIndex, 0))
              }
            }}
            className="flex h-full w-10 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-e-lg text-muted-foreground outline-none active:translate-y-px disabled:cursor-not-allowed motion-reduce:active:translate-y-0 [@media(hover:hover)]:hover:text-foreground"
          >
            {visualState === 'loading' ? (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : visualState === 'error' ? (
              <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
            ) : visualState === 'success' ? (
              <Check className="size-3.5 text-status-success-accent" aria-hidden="true" />
            ) : null}
            <ChevronDown
              className={cn(
                'size-4 transition-transform duration-150 motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
        className="max-h-64 min-w-48 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
        style={{ width: anchorWidth }}
      >
        {presets.map((preset, index) => {
          const selected = String(preset) === value
          const active = index === activeIndex
          return (
            <div
              key={preset}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={selected}
              data-active={active || undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectPreset(preset)}
              className="relative flex min-h-8 cursor-pointer items-center rounded-md px-2.5 py-1.5 pe-8 text-sm font-normal tabular-nums outline-none select-none data-[active]:bg-muted [@media(hover:hover)]:hover:bg-muted"
            >
              {formatter.format(preset)}
              {selected ? (
                <Check className="absolute end-2 size-4 text-muted-foreground" aria-hidden="true" />
              ) : null}
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export {
  EditableNumberCombobox,
  type EditableNumberComboboxPreviewState,
  type EditableNumberComboboxStatus
}
