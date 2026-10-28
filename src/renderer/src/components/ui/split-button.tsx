import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefCallback
} from 'react'
import { Button } from './button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from './dropdown-menu'
import { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from './popover'
import { cn } from '@/lib/utils'
import './split-button.css'

type Kind = 'menu' | 'popover'
type SplitContext = {
  kind: Kind
  open: boolean
  disabled: boolean
  busy: boolean
  hideMenu: boolean
  group: HTMLDivElement | null
  setGroup: (node: HTMLDivElement | null) => void
  trigger: HTMLButtonElement | null
  setTrigger: (node: HTMLButtonElement | null) => void
}
const Context = createContext<SplitContext | null>(null)
const useSplit = (): SplitContext => {
  const context = useContext(Context)
  if (!context) throw new Error('SplitButton parts require SplitButton')
  return context
}

export const SplitButton = ({
  kind = 'menu',
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  busy = false,
  hideMenu = false,
  modal = false,
  children
}: {
  kind?: Kind
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  busy?: boolean
  hideMenu?: boolean
  modal?: boolean
  children: ReactNode
}): React.JSX.Element => {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const [group, setGroup] = useState<HTMLDivElement | null>(null)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const unavailable = disabled || busy || hideMenu
  const open = !unavailable && (controlledOpen ?? localOpen)
  const change = (next: boolean): void => {
    const value = next && !unavailable
    setLocalOpen(value)
    onOpenChange?.(value)
  }
  const Root = kind === 'menu' ? DropdownMenu : Popover
  return (
    <Context.Provider
      value={{ kind, open, disabled, busy, hideMenu, group, setGroup, trigger, setTrigger }}
    >
      <Root open={open} onOpenChange={change} modal={modal}>
        {children}
      </Root>
    </Context.Provider>
  )
}

// React 19 callback refs may return cleanup; preserve it through both Radix and asChild composition.
const assignRef = <T,>(ref: Ref<T> | undefined, node: T | null): void | (() => void) => {
  if (typeof ref === 'function') return ref(node)
  if (ref) ref.current = node
}

const useBoundRef = <T,>(
  ref: Ref<T> | undefined,
  attach: (node: T | null) => void
): RefCallback<T> =>
  useCallback(
    (node: T | null) => {
      attach(node)
      const cleanup = assignRef(ref, node)
      return () => {
        attach(null)
        if (typeof cleanup === 'function') cleanup()
        else assignRef(ref, null)
      }
    },
    [ref, attach]
  )

export const SplitButtonGroup = ({
  ref,
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element => {
  const { kind, open, busy, hideMenu, setGroup } = useSplit()
  const bind = useBoundRef(ref, setGroup)
  const group = (
    <div
      {...props}
      ref={bind}
      role={props.role ?? 'group'}
      aria-busy={busy || undefined}
      data-split-group=""
      data-open={open}
      data-single={hideMenu}
      className={cn('split-button-group', className)}
    />
  )
  return kind === 'popover' ? <PopoverAnchor asChild>{group}</PopoverAnchor> : group
}

export const SplitButtonPrimary = ({
  disabled,
  ...props
}: ComponentProps<typeof Button>): React.JSX.Element => {
  const context = useSplit()
  return (
    <Button
      type="button"
      {...props}
      data-split-primary=""
      disabled={disabled || context.disabled || context.busy}
    />
  )
}

export const SplitButtonTrigger = ({
  ref,
  disabled,
  ...props
}: ComponentProps<typeof Button>): React.JSX.Element | null => {
  const { kind, open, hideMenu, disabled: groupDisabled, busy, setTrigger } = useSplit()
  const bind = useBoundRef(ref, setTrigger)
  if (hideMenu) return null
  const Trigger = kind === 'menu' ? DropdownMenuTrigger : PopoverTrigger
  return (
    <Trigger asChild>
      <Button
        type="button"
        {...props}
        ref={bind}
        data-split-trigger=""
        data-state={open ? 'open' : 'closed'}
        disabled={disabled || groupDisabled || busy}
      />
    </Trigger>
  )
}

type ContentProps = ComponentProps<typeof PopoverContent> & {
  matchWidth?: boolean
}

// Read the final floating geometry, including collision shifts, instead of assuming the preferred side.
const connectEdges = (group: HTMLElement, panel: HTMLElement): void => {
  const anchor = group.getBoundingClientRect()
  const floating = panel.getBoundingClientRect()
  const side = panel.dataset.side
  if (side !== 'top' && side !== 'bottom') return
  const start = Math.max(anchor.left, floating.left)
  const end = Math.min(anchor.right, floating.right)
  const touches =
    end > start &&
    Math.abs(side === 'top' ? floating.bottom - anchor.top : floating.top - anchor.bottom) <= 2
  group.dataset.side = side
  group.dataset.connected = String(touches)
  panel.dataset.connected = String(touches)
  const edge = side === 'top' ? 'top' : 'bottom'
  const opposite = side === 'top' ? 'bottom' : 'top'
  for (const vertical of ['top', 'bottom']) {
    for (const horizontal of ['left', 'right']) {
      const groupTouch =
        touches &&
        vertical === edge &&
        (horizontal === 'left' ? start <= anchor.left + 1 : end >= anchor.right - 1)
      const panelTouch =
        touches &&
        vertical === opposite &&
        (horizontal === 'left' ? start <= floating.left + 1 : end >= floating.right - 1)
      group.style.setProperty(
        `--split-${vertical}-${horizontal}`,
        groupTouch ? '0px' : 'var(--radius-lg)'
      )
      panel.style.setProperty(
        `--split-${vertical}-${horizontal}`,
        panelTouch ? '0px' : 'var(--radius-lg)'
      )
    }
  }
  panel.style.setProperty('--split-contact-left', `${Math.max(0, start - floating.left)}px`)
  panel.style.setProperty('--split-contact-width', `${Math.max(0, end - start)}px`)
}

export const SplitButtonContent = ({
  ref,
  className,
  style,
  align = 'end',
  alignOffset = 0,
  side = 'bottom',
  matchWidth = false,
  onCloseAutoFocus,
  onOpenAutoFocus,
  onInteractOutside,
  onEscapeKeyDown,
  onKeyDownCapture,
  onClickCapture,
  ...props
}: ContentProps): React.JSX.Element | null => {
  const { kind, open, group, trigger, hideMenu } = useSplit()
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [resolvedSide, setResolvedSide] = useState<string>()
  const motion = useRef<Animation | null>(null)
  const bind = useBoundRef(ref, setPanel)
  const previousPresence = useRef({ panel, open })
  const closeReason = useRef<'escape' | 'outside' | null>(null)

  const restoreCloseFocus = (event: Event): void => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    // Radix retains outside-interaction flags until unmount. Use this opening's reason instead.
    event.preventDefault()
    if (closeReason.current === 'outside') return
    const doc = trigger?.ownerDocument
    const active = doc?.activeElement
    if (
      active &&
      active !== doc?.body &&
      active !== doc?.documentElement &&
      active !== trigger &&
      !panel?.contains(active)
    )
      return
    trigger?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const previous = previousPresence.current
    previousPresence.current = { panel, open }
    if (open && !previous.open) closeReason.current = null
    if (!open && previous.open && closeReason.current === 'escape') {
      // Return focus before the next keystroke, once Radix has released its focus trap.
      restoreCloseFocus(new Event('splitButton.closeAutoFocus', { cancelable: true }))
    }
    // Radix only autofocuses on mount; interrupted exits retain the panel and its focus scope.
    if (!panel || panel !== previous.panel || !open || previous.open) return
    const event = new Event('splitButton.openAutoFocus', { cancelable: true })
    onOpenAutoFocus?.(event)
    if (event.defaultPrevented) return
    if (kind === 'popover') {
      const candidates = panel.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]'
      )
      for (const candidate of candidates) {
        if (
          candidate.tabIndex < 0 ||
          candidate.matches(':disabled') ||
          !candidate.getClientRects().length ||
          getComputedStyle(candidate).visibility === 'hidden'
        )
          continue
        candidate.focus({ preventScroll: true })
        if (panel.ownerDocument.activeElement === candidate) return
      }
    }
    // Menu's roving-focus group applies its keyboard entry policy when the panel receives focus.
    panel.focus({ preventScroll: true })
  })

  useLayoutEffect(() => {
    if (!group) return
    const update = (): void => setWidth(group.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(group)
    return () => observer.disconnect()
  }, [group])

  useLayoutEffect(() => {
    if (!panel || !group) return
    const update = (): void => {
      connectEdges(group, panel)
      setResolvedSide(panel.dataset.side)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    observer.observe(group)
    const position = new MutationObserver(update)
    position.observe(panel, { attributes: true, attributeFilter: ['data-side'] })
    if (panel.parentElement)
      position.observe(panel.parentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      position.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      group.dataset.connected = 'false'
    }
  }, [group, panel])

  // CSS presence retains the same DOM during exit; WAAPI reverses from the current clipped extent.
  // Only the reveal is animated, so glyphs and the floating anchor never scale or move.
  useLayoutEffect(() => {
    if (!panel) return
    // Floating UI may flip after mounting. Wait for its positioned frame before choosing the reveal edge.
    if (!motion.current) panel.style.setProperty('clip-path', 'inset(0px 0px 100% 0px)')
    const frame = requestAnimationFrame(() => {
      const collapsed =
        panel.dataset.side === 'top' ? 'inset(100% 0px 0px 0px)' : 'inset(0px 0px 100% 0px)'
      const expanded = 'inset(0px 0px 0px 0px)'
      const previous = motion.current
        ? getComputedStyle(panel).clipPath
        : open
          ? collapsed
          : expanded
      motion.current?.cancel()
      const target = open ? expanded : collapsed
      panel.style.setProperty('clip-path', target)
      if (!panel.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      motion.current = panel.animate([{ clipPath: previous }, { clipPath: target }], {
        duration: open ? 240 : 160,
        easing: open ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.4,0,1,1)',
        fill: 'both'
      })
    })
    // Preserve the running animation for the next effect to sample on reversal.
    return () => cancelAnimationFrame(frame)
  }, [panel, open, resolvedSide])

  useLayoutEffect(
    () => () => {
      motion.current?.cancel()
      motion.current = null
    },
    [panel]
  )

  if (hideMenu) return null
  const Content = kind === 'menu' ? DropdownMenuContent : PopoverContent
  const offset =
    kind === 'menu' && align !== 'end' && group && trigger
      ? -(group.getBoundingClientRect().width - trigger.getBoundingClientRect().width) /
        (align === 'center' ? 2 : 1)
      : 0
  return (
    <Content
      {...props}
      ref={bind}
      side={side}
      align={align}
      alignOffset={alignOffset + offset}
      sideOffset={-1}
      onInteractOutside={(event) => {
        onInteractOutside?.(event)
        // The retained closing layer must not dismiss a reopen from its own trigger.
        if (event.target instanceof Node && trigger?.contains(event.target)) event.preventDefault()
        if (open && !event.defaultPrevented) closeReason.current = 'outside'
      }}
      onEscapeKeyDown={(event) => {
        if (!open) return
        onEscapeKeyDown?.(event)
        if (!event.defaultPrevented) closeReason.current = 'escape'
      }}
      onCloseAutoFocus={(event) => {
        // Escape already ran the owner's focus policy; do not steal a subsequent Tab destination.
        if (closeReason.current === 'escape') event.preventDefault()
        else restoreCloseFocus(event)
      }}
      onKeyDownCapture={(event) => {
        // A focused descendant can receive input before the browser applies inert's focus update.
        if (!open) {
          event.preventDefault()
          event.stopPropagation()
        } else onKeyDownCapture?.(event)
      }}
      onClickCapture={(event) => {
        if (!open) {
          event.preventDefault()
          event.stopPropagation()
        } else onClickCapture?.(event)
      }}
      onOpenAutoFocus={onOpenAutoFocus}
      inert={!open || undefined}
      data-split-panel=""
      aria-hidden={!open || undefined}
      className={cn('split-button-panel', className)}
      style={{ ...style, ...(matchWidth && width ? { width, minWidth: width } : {}) }}
    />
  )
}
