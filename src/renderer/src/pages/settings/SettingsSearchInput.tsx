import { Search } from 'lucide-react'
import { useRef, type ComponentProps } from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import {
  getSettingsSearchKeyShortcuts,
  useSettingsSearchShortcut
} from './settings-search-shortcut'

type SettingsSearchInputProps = Omit<ComponentProps<typeof Input>, 'ref' | 'type'> & {
  containerClassName?: string
}

export const SettingsSearchInput = ({
  className,
  containerClassName,
  ...props
}: SettingsSearchInputProps): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement>(null)
  const isMac = window.api?.platform === 'darwin'
  useSettingsSearchShortcut(inputRef)

  return (
    <div className={cn('group relative flex-1', containerClassName)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        {...props}
        ref={inputRef}
        type="search"
        aria-keyshortcuts={getSettingsSearchKeyShortcuts()}
        className={cn('pl-8 pr-20', className)}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 group-focus-within:hidden"
      >
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground shadow-sm">
          {isMac ? '⌘' : 'Ctrl'}
        </kbd>
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground shadow-sm">
          K
        </kbd>
      </span>
    </div>
  )
}
