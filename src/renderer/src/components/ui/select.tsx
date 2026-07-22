import * as React from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'

import { cn } from '@/lib/utils'

// Styled single-choice select built on the radix Select primitive so the app never falls back to the
// browser's native <select> chrome. Supports grouped options (SelectGroup + SelectLabel) and a
// per-item leading icon.

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-muted data-[state=open]:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  scrollToTopOnOpen = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  // Start the list scrolled to the top instead of letting radix scroll the selected item into
  // view. For long lists (e.g. provider types) the selected option would otherwise push the first
  // choices above the viewport (issue #294).
  scrollToTopOnOpen?: boolean
}): React.JSX.Element {
  const viewportRef = React.useRef<HTMLDivElement>(null)

  // The content mounts fresh on every open. Radix scrolls the selected item into view once the
  // floating position settles, which happens on the frames right after mount, so the reset covers
  // that window rather than only the synchronous mount. This relies on radix's internal scroll
  // timing (radix-ui ^1.6.1) — revisit when upgrading the dependency.
  React.useEffect(() => {
    if (!scrollToTopOnOpen) return
    const viewport = viewportRef.current
    if (!viewport) return

    viewport.scrollTop = 0
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = 0
    })
    const settled = window.setTimeout(() => {
      viewport.scrollTop = 0
    }, 150)

    // A deliberate user scroll wins over the pending resets. Listening for scroll events won't
    // work here — radix's own programmatic scroll would cancel the resets it races against — so
    // only direct input (wheel/touch/keyboard) cancels.
    const cancel = (): void => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settled)
    }
    viewport.addEventListener('wheel', cancel, { once: true })
    viewport.addEventListener('touchmove', cancel, { once: true })
    viewport.addEventListener('keydown', cancel, { once: true })

    return () => {
      cancel()
      viewport.removeEventListener('wheel', cancel)
      viewport.removeEventListener('touchmove', cancel)
      viewport.removeEventListener('keydown', cancel)
    }
    // Runs once on mount: SelectContent mounts fresh on every open, so the flag never changes
    // during the content's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          'z-50 max-h-72 min-w-[8rem] overflow-hidden overscroll-contain rounded-lg border border-border bg-popover text-popover-foreground shadow-menu outline-none',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          ref={viewportRef}
          className={cn(
            'p-1.5',
            position === 'popper' &&
              'w-full min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)]'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

// Scroll affordances: radix renders each button only while scrolling is possible in that
// direction, so an overflowing list always hints that more options exist.
function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>): React.JSX.Element {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUp className="size-4 opacity-60" aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>): React.JSX.Element {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>): React.JSX.Element {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  icon,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2 pr-8 text-sm outline-none transition-colors duration-150 select-none motion-reduce:transition-none data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>): React.JSX.Element {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger
}
