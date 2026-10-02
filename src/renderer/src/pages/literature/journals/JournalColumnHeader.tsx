import { useId, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  EyeOff,
  Pencil,
  Hash,
  Type,
  List,
  ListChecks,
  LoaderCircle,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { JOURNAL_FIELD_KINDS, type JournalField } from '../../../../../shared/journal-attributes'

const typeIcons = { text: Type, number: Hash, singleSelect: List, multiSelect: ListChecks }

export function JournalColumnHeader({
  identity,
  label,
  icon: Icon,
  direction,
  disabled,
  onSort,
  field,
  onSave,
  onHide
}: {
  identity: string
  label: string
  icon: LucideIcon
  direction?: 'ascending' | 'descending'
  disabled: boolean
  onSort: (descending: boolean) => void
  field: JournalField
  onSave: (field: JournalField) => Promise<string | undefined>
  onHide: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  const nameId = useId()
  const [draft, setDraft] = useState<JournalField>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const saveSnapshot = useRef(onSave)
  const menuButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const editingRequested = useRef(false)
  const typeLabels = {
    text: t('Text'),
    number: t('Number'),
    singleSelect: t('Single choice'),
    multiSelect: t('Multiple choices')
  }
  const save = async (): Promise<void> => {
    if (!draft || saving || !draft.label.trim()) return
    setSaving(true)
    try {
      const message = await saveSnapshot.current({ ...draft, label: draft.label.trim() })
      if (message) setError(message)
      else setDraft(undefined)
    } catch {
      setError(t('Could not save changes.'))
    } finally {
      setSaving(false)
    }
  }
  const SelectedTypeIcon = typeIcons[draft?.kind ?? field.kind]
  const SortIcon =
    direction === 'ascending' ? ArrowUp : direction === 'descending' ? ArrowDown : ArrowUpDown
  return (
    <Popover
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open && !saving) setDraft(undefined)
      }}
    >
      <PopoverAnchor asChild>
        <ActionMenuTarget
          asChild
          targetId={identity}
          identityKey={identity}
          invocation={null}
          onRestoreFocus={(restoreDefault) => {
            if (editingRequested.current) nameInput.current?.focus()
            else restoreDefault()
          }}
          catalog={{
            edit: { labelKey: 'Edit column', icon: Pencil },
            hide: { labelKey: 'Hide column', icon: EyeOff },
            ascending: { labelKey: 'Sort ascending', icon: ArrowUp },
            descending: { labelKey: 'Sort descending', icon: ArrowDown }
          }}
          recipe={[
            { kind: 'action', action: 'edit' },
            { kind: 'action', action: 'hide' },
            { kind: 'separator' },
            { kind: 'action', action: 'ascending' },
            { kind: 'action', action: 'descending' }
          ]}
          bindings={{
            edit: {
              disabled,
              execute: () => {
                editingRequested.current = true
                setDraft({ ...field })
                setError('')
                saveSnapshot.current = onSave
              }
            },
            hide: { disabled, execute: onHide },
            ascending: { disabled, execute: () => onSort(false) },
            descending: { disabled, execute: () => onSort(true) }
          }}
        >
          <div className="group/column flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-0 font-medium"
              onClick={() => onSort(direction === 'ascending')}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate" title={label}>
                {label}
              </span>
              <SortIcon
                className={`size-3.5 shrink-0 ${direction ? 'text-primary' : 'text-muted-foreground/60'}`}
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 opacity-0 group-hover/column:opacity-100 group-focus-within/column:opacity-100 [@media(hover:none)]:opacity-100"
              ref={menuButton}
              disabled={disabled}
              aria-label={t('Column actions for {{name}}', { name: label })}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                openMenu({
                  targetId: identity,
                  pointer: { x: bounds.right, y: bounds.bottom },
                  align: 'end',
                  focusTarget: event.currentTarget
                })
              }}
            >
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </ActionMenuTarget>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-4 rounded-xl border border-border bg-card p-4 text-sm text-foreground shadow-dialog"
        aria-label={t('Edit column')}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          editingRequested.current = false
          menuButton.current?.focus()
        }}
      >
        {draft ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor={nameId} className="text-xs text-muted-foreground">
                {t('Attribute name')}
              </label>
              <Input
                ref={nameInput}
                id={nameId}
                autoFocus
                maxLength={100}
                value={draft.label}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t('Attribute type')}</p>
              <Select
                value={draft.kind}
                disabled={saving}
                onValueChange={(kind) => setDraft({ ...draft, kind: kind as JournalField['kind'] })}
              >
                <SelectTrigger aria-label={t('Attribute type')}>
                  <span className="flex min-w-0 items-center gap-2">
                    <SelectedTypeIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <SelectValue className="truncate" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {JOURNAL_FIELD_KINDS.map((kind) => {
                    const TypeIcon = typeIcons[kind]
                    return (
                      <SelectItem
                        key={kind}
                        value={kind}
                        icon={<TypeIcon className="size-4" aria-hidden="true" />}
                      >
                        {typeLabels[kind]}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setDraft(undefined)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={saving || !draft.label.trim()} aria-busy={saving}>
                {saving ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {saving ? t('Saving…') : t('Save')}
              </Button>
            </div>
          </form>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
