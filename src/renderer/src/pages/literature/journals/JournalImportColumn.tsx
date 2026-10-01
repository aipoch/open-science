import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  JOURNAL_EXTERNAL_ID_NAMESPACES,
  JOURNAL_FIELD_KINDS,
  type JournalField
} from '../../../../../shared/journal-attributes'
import { LiteratureTextTooltip } from '../LiteratureTable'
import { journalFieldKindIcons } from './journal-field-icons'
import { type JournalColumn } from './journal-import-file'

export function JournalImportColumn({
  column,
  label,
  example,
  busy,
  updateColumn,
  roles,
  availableFields,
  kinds
}: {
  column: JournalColumn
  label: string
  example: string
  busy: boolean
  updateColumn: (index: number, patch: Partial<JournalColumn>) => void
  roles: {
    ignore: string
    name: string
    alias: string
    issn: string
    externalId: string
    attribute: string
  }
  availableFields: Array<JournalField & { columnKey?: string }>
  kinds: { text: string; number: string; singleSelect: string; multiSelect: string }
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <tr className="border-t border-border-300/80 hover:bg-bg-100" key={column.index}>
      <td className="p-2">
        <LiteratureTextTooltip text={label}>
          <span className="block truncate">{label}</span>
        </LiteratureTextTooltip>
      </td>
      <td className="p-2">
        <LiteratureTextTooltip text={example}>
          <span className="block truncate">{example || '—'}</span>
        </LiteratureTextTooltip>
      </td>
      <td className="p-2">
        <Select
          value={column.role}
          disabled={busy}
          onValueChange={(value) =>
            updateColumn(column.index, { role: value as JournalColumn['role'] })
          }
        >
          <SelectTrigger
            aria-label={t('Role for column {{number}}', {
              number: column.index + 1
            })}
            className="w-full max-w-40 min-w-0"
          >
            <SelectValue>{roles[column.role]}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-60 max-w-[calc(100vw-2rem)]">
            <SelectItem value="ignore">{roles.ignore}</SelectItem>
            <SelectSeparator />
            <SelectGroup>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SelectLabel className="flex items-center gap-1.5 py-2 font-semibold">
                    {t('Identify journals')}
                    <Info className="size-3.5" aria-hidden="true" />
                  </SelectLabel>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {t('Used for matching, not as attribute columns.')}
                </TooltipContent>
              </Tooltip>
              {(['name', 'alias', 'issn', 'externalId'] as const).map((value) => (
                <Tooltip key={value}>
                  <TooltipTrigger asChild>
                    <SelectItem value={value}>{roles[value]}</SelectItem>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t('Used for matching, not as attribute columns.')}
                  </TooltipContent>
                </Tooltip>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectItem value="attribute">
                  <span className="flex items-center gap-1.5">
                    {roles.attribute}
                    <Info className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                </SelectItem>
              </TooltipTrigger>
              <TooltipContent side="right">
                {t('Show and filter these columns in the literature table.')}
              </TooltipContent>
            </Tooltip>
          </SelectContent>
        </Select>
      </td>
      <td className="p-2">
        {column.role === 'externalId' ? (
          <div className="space-y-1">
            <Select
              value={column.customExternalNamespace ? 'custom' : column.externalNamespace || 'none'}
              disabled={busy}
              onValueChange={(value) =>
                updateColumn(column.index, {
                  customExternalNamespace: value === 'custom',
                  externalNamespace: value === 'none' || value === 'custom' ? '' : value
                })
              }
            >
              <SelectTrigger
                aria-label={t('External identifier namespace')}
                className="w-full max-w-44 min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('Choose namespace')}</SelectItem>
                {JOURNAL_EXTERNAL_ID_NAMESPACES.map((namespace) => (
                  <SelectItem key={namespace} value={namespace}>
                    {namespace.toUpperCase()}
                  </SelectItem>
                ))}
                <SelectItem value="custom">{t('Custom namespace')}</SelectItem>
              </SelectContent>
            </Select>
            {column.customExternalNamespace ? (
              <Input
                aria-label={t('Custom namespace')}
                placeholder="publisher-id"
                disabled={busy}
                maxLength={80}
                value={column.externalNamespace ?? ''}
                onChange={(event) =>
                  updateColumn(column.index, {
                    externalNamespace: event.target.value
                  })
                }
              />
            ) : null}
          </div>
        ) : column.role === 'attribute' ? (
          <div className="space-y-1">
            {availableFields.length ? (
              <Select
                value={
                  availableFields.some(({ id }) => id === column.field.id) ? column.field.id : 'new'
                }
                disabled={busy}
                onValueChange={(value) => {
                  const existing = availableFields.find(({ id }) => id === value)
                  const fresh = { ...column.field, columnKey: undefined }
                  updateColumn(column.index, {
                    field: existing ?? { ...fresh, id: crypto.randomUUID() }
                  })
                }}
              >
                <SelectTrigger
                  aria-label={t('Journal attribute')}
                  className="w-full max-w-44 min-w-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">{t('New')}</SelectItem>
                  {availableFields.map((field) => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Input
              aria-label={t('Attribute name')}
              value={column.field.label}
              disabled={busy}
              maxLength={100}
              className="w-full max-w-56 min-w-0"
              onChange={(event) =>
                updateColumn(column.index, {
                  field: { ...column.field, label: event.target.value }
                })
              }
            />
          </div>
        ) : null}
      </td>
      <td className="p-2">
        {column.role === 'attribute' ? (
          <Select
            value={column.field.kind}
            disabled={busy || availableFields.some(({ id }) => id === column.field.id)}
            onValueChange={(value) =>
              updateColumn(column.index, {
                field: {
                  ...column.field,
                  kind: value as JournalColumn['field']['kind']
                }
              })
            }
          >
            <SelectTrigger aria-label={t('Attribute type')} className="w-full max-w-40 min-w-0">
              <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                {(() => {
                  const Icon = journalFieldKindIcons[column.field.kind]
                  return <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                })()}
                <SelectValue className="truncate" />
              </span>
            </SelectTrigger>
            <SelectContent>
              {JOURNAL_FIELD_KINDS.map((kind) => {
                const Icon = journalFieldKindIcons[kind]
                return (
                  <SelectItem
                    key={kind}
                    value={kind}
                    icon={<Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
                  >
                    {kinds[kind]}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        ) : null}
      </td>
    </tr>
  )
}
