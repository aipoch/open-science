import type { PopoverContent } from '@/components/ui/popover'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const MenuGroup = createContext<{
  active: string | null
  setActive: Dispatch<SetStateAction<string | null>>
} | null>(null)

export function LiteratureHoverMenuGroup({ children }: { children: ReactNode }): React.JSX.Element {
  const [active, setActive] = useState<string | null>(null)
  return <MenuGroup.Provider value={{ active, setActive }}>{children}</MenuGroup.Provider>
}

// Keep searchable destination popovers accessible: hover does not move focus;
// clicking or using the keyboard retains normal Radix focus and dismissal.
// eslint-disable-next-line react-refresh/only-export-components
export function useLiteratureHoverMenu(disabled = false): {
  open: boolean
  setOpen: (next: boolean) => void
  triggerProps: Pick<
    React.HTMLAttributes<HTMLElement>,
    'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onKeyDown'
  >
  contentProps: Pick<
    React.ComponentProps<typeof PopoverContent>,
    | 'side'
    | 'align'
    | 'sideOffset'
    | 'collisionPadding'
    | 'onPointerEnter'
    | 'onPointerLeave'
    | 'onPointerDown'
    | 'onKeyDown'
    | 'onOpenAutoFocus'
    | 'onCloseAutoFocus'
  >
} {
  const group = useContext(MenuGroup)
  const id = useId()
  const [localOpen, setLocalOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinned = useRef(false)
  const open = group ? group.active === id : localOpen
  const clear = (): void => {
    clearTimeout(timer.current)
  }
  const setOpen = (next: boolean): void => {
    clear()
    if (group) group.setActive((active) => (next ? id : active === id ? null : active))
    else setLocalOpen(next)
  }
  useEffect(() => () => clearTimeout(timer.current), [disabled])
  const leave = (): void => {
    clear()
    if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 180)
  }
  const pin = (): void => {
    pinned.current = true
    clear()
  }
  return {
    open,
    setOpen,
    triggerProps: {
      onPointerEnter: (event: React.PointerEvent): void => {
        if (disabled || event.pointerType === 'touch') return
        clear()
        if (open) return
        pinned.current = false
        timer.current = setTimeout(() => setOpen(true), 120)
      },
      onPointerLeave: leave,
      onPointerDown: pin,
      onKeyDown: pin
    },
    contentProps: {
      side: 'right' as const,
      align: 'start' as const,
      sideOffset: 6,
      collisionPadding: 8,
      onPointerEnter: clear,
      onPointerLeave: leave,
      onPointerDown: pin,
      onKeyDown: pin,
      onOpenAutoFocus: (event: Event): void => {
        if (!pinned.current) event.preventDefault()
      },
      onCloseAutoFocus: (event: Event): void => {
        if (!pinned.current) event.preventDefault()
      }
    }
  }
}

export function LiteratureHoverDropdown({
  trigger,
  children,
  disabled
}: {
  trigger: ReactElement
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  const menu = useLiteratureHoverMenu(disabled)
  return (
    <DropdownMenu modal={false} open={menu.open} onOpenChange={menu.setOpen}>
      <DropdownMenuTrigger asChild {...menu.triggerProps}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent {...menu.contentProps}>{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}
