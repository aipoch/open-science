import { Search, X } from 'lucide-react'
import { useRef, useState, type ChangeEvent, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import {
  getSettingsSearchKeyShortcuts,
  useSettingsSearchShortcut
} from './settings-search-shortcut'

type SettingsSearchInputProps = Omit<ComponentProps<typeof Input>, 'ref' | 'type'> & {
  containerClassName?: string
  // ⌘K priority within the same topmost dialog; the dialog-wide settings search passes a higher
  // value so panel-scoped fields that mounted later do not capture the shortcut.
  shortcutPriority?: number
}

export const SettingsSearchInput = ({
  className,
  containerClassName,
  shortcutPriority,
  value,
  defaultValue,
  onChange,
  ...props
}: SettingsSearchInputProps): React.JSX.Element => {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const isMac = window.api?.platform === 'darwin'
  useSettingsSearchShortcut(inputRef, true, shortcutPriority ?? 0)
  const [uncontrolledText, setUncontrolledText] = useState(
    typeof defaultValue === 'string' ? defaultValue : ''
  )
  const hasText = value !== undefined ? String(value).length > 0 : uncontrolledText.length > 0

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setUncontrolledText(event.target.value)
    onChange?.(event)
  }

  const clearQuery = (): void => {
    const input = inputRef.current
    if (!input) return
    // Route the clear through a real input event so controlled and uncontrolled parents both see
    // a normal change, then keep focus in the field for continued typing.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    setUncontrolledText('')
    input.focus()
  }

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
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        aria-keyshortcuts={getSettingsSearchKeyShortcuts()}
        className={cn('pl-8 pr-20 [&::-webkit-search-cancel-button]:hidden', className)}
      />
      {hasText ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-slot="settings-search-clear"
          aria-label={t('Clear search')}
          title={t('Clear search')}
          className="absolute inset-y-0 right-1.5 my-auto text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clearQuery}
        >
          <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </Button>
      ) : (
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
      )}
    </div>
  )
}
