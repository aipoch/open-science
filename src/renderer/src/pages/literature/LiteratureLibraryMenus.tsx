import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Upload
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiteratureHoverDropdown } from './LiteratureHoverMenus'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export function LiteratureAddMenu({
  label,
  onAddReference,
  onImportPdf,
  onImportReferences
}: Readonly<{
  label?: string
  onAddReference: () => void
  onImportPdf: () => void
  onImportReferences: () => void
}>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className="shrink-0 transition-none">
          <Plus data-icon="inline-start" aria-hidden="true" />
          {label ?? t('Add')}
          <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          className="gap-2.5"
          aria-label={t('Add reference')}
          onSelect={onAddReference}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Add reference')}</span>
            <span className="text-xs text-muted-foreground">{t('Create metadata manually')}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" aria-label={t('Import PDFs')} onSelect={onImportPdf}>
          <FilePlus2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Import PDFs')}</span>
            <span className="text-xs text-muted-foreground">
              {t('Create references from PDF files')}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2.5"
          aria-label={t('Import references')}
          onSelect={onImportReferences}
        >
          <Upload className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Import references')}</span>
            <span className="text-xs text-muted-foreground">
              {t('BibTeX, RIS, or PubMed NBIB')}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function LiteratureExportMenu({
  disabled,
  onExport
}: Readonly<{
  disabled?: boolean
  onExport: (format: 'bibtex' | 'ris') => Promise<boolean>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'success'>('idle')
  const resetTimeoutRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    },
    []
  )

  const runExport = async (format: 'bibtex' | 'ris'): Promise<void> => {
    if (status === 'loading') return
    if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    setStatus('loading')
    try {
      const saved = await onExport(format)
      setStatus(saved ? 'success' : 'idle')
      if (saved) {
        resetTimeoutRef.current = window.setTimeout(() => setStatus('idle'), 1_500)
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <LiteratureHoverDropdown
      disabled={disabled || status === 'loading'}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || status === 'loading'}
          aria-invalid={status === 'error' || undefined}
          aria-busy={status === 'loading'}
          data-state={status}
        >
          {status === 'loading' ? (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : status === 'success' ? (
            <Check className="size-3.5 text-primary" aria-hidden="true" />
          ) : (
            <Download className="size-3.5" aria-hidden="true" />
          )}
          {status === 'loading' ? t('Exporting…') : status === 'success' ? t('Saved') : t('Export')}
          <ChevronRight className="ml-auto size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      }
    >
      <DropdownMenuItem onSelect={() => void runExport('bibtex')}>
        <FileText className="mr-2 size-4" aria-hidden="true" />
        {t('BibTeX')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void runExport('ris')}>
        <FileText className="mr-2 size-4" aria-hidden="true" />
        {t('RIS')}
      </DropdownMenuItem>
    </LiteratureHoverDropdown>
  )
}

function LibraryMenuTrigger({ status }: { status: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('More actions')}
      disabled={status === 'loading'}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId: 'library-actions',
          pointer: { x: bounds.right, y: bounds.bottom },
          align: 'end',
          focusTarget: event.currentTarget
        })
      }}
    >
      {status === 'loading' ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : status === 'success' ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <MoreHorizontal className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}
export function LiteratureLibraryActionsMenu({
  exportDisabled,
  onEdit,
  onDelete,
  identityKey,
  onExport
}: Readonly<{
  onEdit?: () => void
  onDelete?: () => void
  identityKey: string
  exportDisabled?: boolean
  onExport: (format: 'bibtex' | 'ris') => Promise<boolean>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'success'>('idle')
  const resetTimeoutRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    },
    []
  )

  const runExport = async (format: 'bibtex' | 'ris'): Promise<void> => {
    if (status === 'loading') return
    if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    setStatus('loading')
    try {
      const saved = await onExport(format)
      setStatus(saved ? 'success' : 'idle')
      if (saved) {
        resetTimeoutRef.current = window.setTimeout(() => setStatus('idle'), 1_500)
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <ActionMenuProvider onActionError={() => setStatus('error')}>
      <ActionMenuTarget
        asChild
        targetId="library-actions"
        identityKey={identityKey}
        invocation={identityKey}
        catalog={{
          edit: { labelKey: 'Edit collection', icon: Pencil },
          remove: { labelKey: 'Delete collection', icon: Trash2, danger: true },
          bibtex: { labelKey: 'BibTeX', icon: FileText },
          ris: { labelKey: 'RIS', icon: FileText }
        }}
        recipe={[
          { kind: 'action', action: 'edit' },
          { kind: 'submenu', labelKey: 'Export', icon: Download, actions: ['bibtex', 'ris'] },
          { kind: 'separator' },
          { kind: 'action', action: 'remove' }
        ]}
        bindings={{
          edit: { execute: () => onEdit?.(), hidden: !onEdit },
          remove: { execute: () => onDelete?.(), hidden: !onDelete },
          bibtex: { execute: () => runExport('bibtex'), disabled: exportDisabled },
          ris: { execute: () => runExport('ris'), disabled: exportDisabled }
        }}
      >
        <div>
          <LibraryMenuTrigger status={status} />
        </div>
      </ActionMenuTarget>
      {status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {t('References could not be exported.')}
        </p>
      )}
    </ActionMenuProvider>
  )
}
