import { AlertDialog } from 'radix-ui'
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Check,
  Copy,
  Folder,
  Info,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ABOUT_YOU_MEMORY_CATEGORY_ID,
  MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH,
  MEMORY_CATEGORY_NAME_MAX_LENGTH,
  MEMORY_CUSTOM_CATEGORY_LIMIT,
  MEMORY_ENTRY_MAX_LENGTH,
  type MemoryCategoryView,
  type MemoryEntryView
} from '../../../../shared/memory'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useMemoryStore } from '@/stores/memory-store'

export type MemoryView =
  { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; categoryId: string }

type MemoryPanelProps = {
  view: MemoryView
  onNavigate(view: MemoryView): void
  onOpenProject?(projectId: string): void
}

type CustomMemoryCategoryView = Extract<MemoryCategoryView, { name: string }>

const isAboutYou = (
  category: MemoryCategoryView
): category is Extract<MemoryCategoryView, { systemKey: 'about-you' }> => 'systemKey' in category

const categoryName = (category: MemoryCategoryView, aboutYou: string): string =>
  isAboutYou(category) ? aboutYou : category.name

type Translate = ReturnType<typeof useTranslation>['t']

const translateMemoryError = (t: Translate, error: unknown): string => {
  const message = error instanceof Error ? error.message : error
  switch (message) {
    case 'A memory category with this name already exists.':
      return t('A memory category with this name already exists.')
    case `You can create up to ${MEMORY_CUSTOM_CATEGORY_LIMIT} memory categories.`:
      return t('You can create up to {{limit}} memory categories.', {
        limit: MEMORY_CUSTOM_CATEGORY_LIMIT
      })
    case 'Memory category changed. Refresh and try again.':
      return t('Memory category changed. Refresh and try again.')
    case 'Memory note changed or no longer exists.':
      return t('Memory note changed or no longer exists.')
    case 'Memory category not found.':
      return t('Memory category no longer exists.')
    case 'Memory note is required.':
      return t('Memory note is required.')
    case 'Memory category name is required.':
      return t('Memory category name is required.')
    case 'Memory category name is too long.':
    case 'Memory category guidance is too long.':
    case 'Memory note is too long.':
      return t('Memory text is too long.')
    default:
      return t('Memory could not be updated.')
  }
}

const MemoryErrorBanner = ({ message }: { message: string }): React.JSX.Element => (
  <div
    role="alert"
    className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <p className="min-w-0 break-words leading-5">{message}</p>
  </div>
)

const confirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm
}: {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm(): void
}): React.JSX.Element => {
  const { t } = useTranslation()

  // Memory confirmations sit above Settings while retaining the same compact dialog chrome.
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[70]!')} />
        <AlertDialog.Content
          data-slot="memory-confirm-dialog"
          className={dialogPanelClassName('z-[70]!', 'w-[min(440px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>{title}</AlertDialog.Title>
            </div>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={dialogCloseButtonClassName}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </AlertDialog.Cancel>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {description}
            </AlertDialog.Description>
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button type="button" className={confirmButtonClassName} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

const CategoryForm = ({
  category,
  customCount,
  onCancel
}: {
  category?: Extract<MemoryCategoryView, { name: string }>
  customCount: number
  onCancel(): void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const createCategory = useMemoryStore((state) => state.createCategory)
  const updateCategory = useMemoryStore((state) => state.updateCategory)
  const [name, setName] = useState(category?.name ?? '')
  const [guidance, setGuidance] = useState(category?.guidance ?? '')
  const [autoRecall, setAutoRecall] = useState(category?.autoRecall ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const canSubmit = Boolean(name.trim() && guidance.trim()) && !saving

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    setError(undefined)
    try {
      if (category) {
        await updateCategory({
          id: category.id,
          expectedRevision: category.revision,
          name,
          guidance,
          autoRecall
        })
      } else {
        await createCategory({ name, guidance, autoRecall })
      }
      onCancel()
    } catch (failure) {
      setError(translateMemoryError(t, failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-5 px-4 py-4 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t('Categories group related memory across all of your projects.')}
      </p>
      <label className="space-y-1.5 text-sm font-medium">
        <span>
          {t('Name')}
          <RequiredMark />
        </span>
        <Input
          name="memory-category-name"
          value={name}
          required
          maxLength={MEMORY_CATEGORY_NAME_MAX_LENGTH}
          placeholder={t('e.g. experiment results')}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        <span>
          {t('When should the agent save a note here?')}
          <RequiredMark />
        </span>
        <Textarea
          name="memory-category-guidance"
          value={guidance}
          required
          maxLength={MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH}
          placeholder={t('Save findings that will be useful in future sessions')}
          className="min-h-24 resize-y"
          onChange={(event) => setGuidance(event.target.value)}
        />
      </label>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('Auto-recall')}</p>
          <p className="text-xs text-muted-foreground">
            {t('Automatically include relevant notes in agent context.')}
          </p>
        </div>
        <Switch
          checked={autoRecall}
          onCheckedChange={setAutoRecall}
          aria-label={t('Auto-recall')}
        />
      </div>
      {error ? <MemoryErrorBanner message={error} /> : null}
      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        <p className="text-sm text-muted-foreground">
          {t('{{count}} of {{limit}} categories used', {
            count: customCount,
            limit: MEMORY_CUSTOM_CATEGORY_LIMIT
          })}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {saving ? t('Saving…') : category ? t('Save') : t('Create')}
          </Button>
        </div>
      </div>
    </form>
  )
}

const NoteEditor = ({
  initialValue = '',
  placeholder,
  onCancel,
  onSave
}: {
  initialValue?: string
  placeholder: string
  onCancel(): void
  onSave(value: string): Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!value.trim() || saving) return
    setSaving(true)
    try {
      await onSave(value)
      onCancel()
    } catch {
      // The store exposes the user-facing error and the editor stays open for retry.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-b border-border p-3">
      <Textarea
        autoFocus
        value={value}
        required
        maxLength={MEMORY_ENTRY_MAX_LENGTH}
        aria-label={t('Memory note')}
        placeholder={placeholder}
        className="min-h-20 resize-y"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void save()
          if (event.key === 'Escape') onCancel()
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!value.trim() || saving}
          onClick={() => void save()}
        >
          <Check aria-hidden="true" />
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

const EntryRow = ({
  entry,
  viewKind,
  onRequestDelete
}: {
  entry: MemoryEntryView
  viewKind: 'category' | 'project'
  onRequestDelete(entry: MemoryEntryView): void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const updateEntry = useMemoryStore((state) => state.updateEntry)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const entryCategoryName =
    entry.categoryId === ABOUT_YOU_MEMORY_CATEGORY_ID ? t('About you') : entry.categoryName
  const categoryLabel =
    viewKind === 'project'
      ? (entryCategoryName ?? (entry.origin === 'agent' ? t('Uncategorized') : null))
      : null
  const projectLabel = viewKind === 'category' ? entry.projectName : null
  const showMetadata = entry.origin === 'agent' || categoryLabel || projectLabel

  const copyNote = async (): Promise<void> => {
    setCopied(false)
    try {
      if (!navigator.clipboard) return
      await navigator.clipboard.writeText(entry.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }

  if (editing) {
    return (
      <NoteEditor
        initialValue={entry.content}
        placeholder={t('Add a note…')}
        onCancel={() => setEditing(false)}
        onSave={(content) =>
          updateEntry({ id: entry.id, expectedRevision: entry.revision, content })
        }
      />
    )
  }

  return (
    <div data-slot="memory-entry" className="group mx-1 rounded-lg px-3 py-2.5 hover:bg-muted/60">
      <div className="flex min-h-6 items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5">
          {entry.content}
        </p>
        <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('Copy note')}
                onClick={() => void copyNote()}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? t('Copied') : t('Copy note')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('Edit note')}
                onClick={() => setEditing(true)}
              >
                <Pencil aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Edit note')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:text-destructive"
                aria-label={t('Delete note')}
                onClick={() => onRequestDelete(entry)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Delete note')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {showMetadata ? (
        <div
          data-slot="memory-entry-metadata"
          className="mt-1 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        >
          {entry.origin === 'agent' ? <span>{t('auto')}</span> : null}
          {entry.origin === 'agent' && (categoryLabel || projectLabel) ? (
            <span aria-hidden="true">·</span>
          ) : null}
          {categoryLabel ? (
            <span className="max-w-52 truncate rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">
              {categoryLabel}
            </span>
          ) : null}
          {projectLabel ? (
            <span className="flex max-w-52 items-center gap-1 truncate rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">
              <Folder className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{projectLabel}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const MemoryList = ({
  onNavigate,
  onOpenProject
}: Pick<MemoryPanelProps, 'onNavigate' | 'onOpenProject'>): React.JSX.Element => {
  const { t } = useTranslation()
  const enabled = useMemoryStore((state) => state.enabled)
  const categories = useMemoryStore((state) => state.categories)
  const projects = useMemoryStore((state) => state.projects)
  const selectedCategoryId = useMemoryStore((state) => state.selectedCategoryId)
  const selectedProjectId = useMemoryStore((state) => state.selectedProjectId)
  const error = useMemoryStore((state) => state.error)
  const selectCategory = useMemoryStore((state) => state.selectCategory)
  const selectProject = useMemoryStore((state) => state.selectProject)
  const setEnabled = useMemoryStore((state) => state.setEnabled)
  const updateCategory = useMemoryStore((state) => state.updateCategory)
  const deleteCategory = useMemoryStore((state) => state.deleteCategory)
  const createEntry = useMemoryStore((state) => state.createEntry)
  const deleteEntry = useMemoryStore((state) => state.deleteEntry)
  const clearAll = useMemoryStore((state) => state.clearAll)
  const selectedCategory = selectedProjectId
    ? undefined
    : (categories.find(({ id }) => id === selectedCategoryId) ?? categories[0])
  const selectedProject = projects.find(({ projectId }) => projectId === selectedProjectId)
  const customCount = categories.filter((category) => !isAboutYou(category)).length
  const [addingTarget, setAddingTarget] = useState<string>()
  const [confirmClear, setConfirmClear] = useState(false)
  const [pendingDeleteCategory, setPendingDeleteCategory] = useState<CustomMemoryCategoryView>()
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<MemoryEntryView>()
  const hasEntries =
    categories.some((category) => category.entries.length > 0) ||
    projects.some((project) => project.entries.length > 0)
  const selectedEntries = selectedProject?.entries ?? selectedCategory?.entries ?? []
  const selectedTarget = selectedProject
    ? `project:${selectedProject.projectId}`
    : selectedCategory
      ? `category:${selectedCategory.id}`
      : undefined
  const adding = selectedTarget === addingTarget

  return (
    <TooltipProvider delayDuration={250}>
      <div data-slot="memory-panel" className="flex h-full min-h-0 flex-col px-3 py-3 md:px-4">
        <div className="mb-3 flex min-h-8 items-center justify-end gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{enabled ? t('On') : t('Off')}</span>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => void setEnabled(checked).catch(() => undefined)}
              aria-label={t('Memory')}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasEntries && customCount === 0}
            className="text-muted-foreground"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 aria-hidden="true" />
            {t('Clear all')}
          </Button>
        </div>

        {!enabled ? (
          <div
            data-slot="memory-disabled-notice"
            className="mb-3 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
          >
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              {t(
                'Memory is off. Agents will not save or recall notes, but you can still edit them.'
              )}
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mb-2">
            <MemoryErrorBanner
              message={
                error === 'load' ? t('Memory could not be loaded.') : translateMemoryError(t, error)
              }
            />
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-border bg-muted/20 p-2 md:border-r md:border-b-0">
            <nav aria-label={t('Memory categories')} className="space-y-1">
              {categories.map((category) => {
                const Icon = isAboutYou(category) ? UserRound : Bell
                return (
                  <button
                    key={category.id}
                    type="button"
                    aria-current={category.id === selectedCategory?.id ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted',
                      category.id === selectedCategory?.id && 'bg-muted font-medium'
                    )}
                    onClick={() => selectCategory(category.id)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      {categoryName(category, t('About you'))}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {category.entries.length}
                    </span>
                  </button>
                )
              })}
              <button
                type="button"
                disabled={customCount >= MEMORY_CUSTOM_CATEGORY_LIMIT}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => onNavigate({ kind: 'create' })}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('New category')}
              </button>
            </nav>
            {projects.length > 0 ? (
              <>
                <Separator className="my-2 h-px w-full" />
                <nav aria-label={t('Project memory')} className="space-y-1">
                  {projects.map((project) => (
                    <button
                      key={project.projectId}
                      type="button"
                      aria-current={
                        project.projectId === selectedProject?.projectId ? 'page' : undefined
                      }
                      className={cn(
                        'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted',
                        project.projectId === selectedProject?.projectId && 'bg-muted font-medium'
                      )}
                      onClick={() => selectProject(project.projectId)}
                    >
                      <Folder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {project.entries.length}
                      </span>
                    </button>
                  ))}
                </nav>
              </>
            ) : null}
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col bg-card">
            {selectedCategory || selectedProject ? (
              <>
                <div className="flex min-h-13 items-center justify-between gap-3 border-b border-border px-4 py-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">
                      {selectedProject
                        ? selectedProject.name
                        : categoryName(selectedCategory!, t('About you'))}
                    </h3>
                    {selectedProject ? (
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">
                          {selectedProject.archived
                            ? t('Archived project memories.')
                            : t('Project memories.')}
                        </span>
                        {!selectedProject.archived && onOpenProject ? (
                          <button
                            type="button"
                            className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline"
                            onClick={() => onOpenProject(selectedProject.projectId)}
                          >
                            {t('Open project')}
                            <ArrowUpRight className="size-3" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : selectedCategory &&
                      !isAboutYou(selectedCategory) &&
                      selectedCategory.guidance ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {selectedCategory.guidance}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAddingTarget(selectedTarget)}
                    >
                      <Plus aria-hidden="true" />
                      {t('Add')}
                    </Button>
                    {selectedCategory && !isAboutYou(selectedCategory) ? (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('Category actions')}
                                onFocus={(event) => {
                                  if (!event.currentTarget.matches(':focus-visible')) {
                                    event.preventDefault()
                                  }
                                }}
                              >
                                <MoreVertical aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>{t('Category actions')}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="min-w-44">
                          <DropdownMenuItem
                            onSelect={() =>
                              onNavigate({ kind: 'edit', categoryId: selectedCategory.id })
                            }
                          >
                            <Pencil className="mr-2 size-4" aria-hidden="true" />
                            {t('Edit')}
                          </DropdownMenuItem>
                          <DropdownMenuCheckboxItem
                            checked={selectedCategory.autoRecall}
                            onCheckedChange={(checked) => {
                              void updateCategory({
                                id: selectedCategory.id,
                                expectedRevision: selectedCategory.revision,
                                name: selectedCategory.name,
                                guidance: selectedCategory.guidance,
                                autoRecall: checked === true
                              }).catch(() => undefined)
                            }}
                          >
                            {t('Auto-recall')}
                          </DropdownMenuCheckboxItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive data-[highlighted]:text-destructive"
                            onSelect={() => setPendingDeleteCategory(selectedCategory)}
                          >
                            <Trash2 className="mr-2 size-4" aria-hidden="true" />
                            {t('Delete category')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </div>
                {adding ? (
                  <NoteEditor
                    placeholder={t('Add a note…')}
                    onCancel={() => setAddingTarget(undefined)}
                    onSave={(content) =>
                      selectedProject
                        ? createEntry({
                            projectId: selectedProject.projectId,
                            categoryId: null,
                            content
                          })
                        : createEntry({ categoryId: selectedCategory!.id, content })
                    }
                  />
                ) : null}
                <div data-slot="memory-entry-list" className="min-h-0 flex-1 overflow-y-auto py-1">
                  {selectedEntries.length === 0 && !adding ? (
                    <p className="px-4 py-4 text-sm text-muted-foreground">{t('No notes yet.')}</p>
                  ) : (
                    selectedEntries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        viewKind={selectedProject ? 'project' : 'category'}
                        onRequestDelete={setPendingDeleteEntry}
                      />
                    ))
                  )}
                </div>
              </>
            ) : null}
          </section>
        </div>

        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title={t('Clear all memory?')}
          description={t(
            'All custom categories and notes will be deleted from current app data. About you will remain. Restoring a database backup may restore older memory.'
          )}
          confirmLabel={t('Clear all')}
          cancelLabel={t('Cancel')}
          onConfirm={() => void clearAll().catch(() => undefined)}
        />
        <ConfirmDialog
          open={Boolean(pendingDeleteEntry)}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteEntry(undefined)
          }}
          title={t('Delete note?')}
          description={t(
            'This note will be deleted from current app data. Restoring a database backup may restore older memory.'
          )}
          confirmLabel={t('Delete note')}
          cancelLabel={t('Cancel')}
          onConfirm={() => {
            if (!pendingDeleteEntry) return
            void deleteEntry({
              id: pendingDeleteEntry.id,
              expectedRevision: pendingDeleteEntry.revision
            }).catch(() => undefined)
          }}
        />
        <ConfirmDialog
          open={Boolean(pendingDeleteCategory)}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteCategory(undefined)
          }}
          title={t('Delete category?')}
          description={t(
            'This category and all {{count}} notes in it will be deleted from current app data. Restoring a database backup may restore older memory.',
            {
              count: pendingDeleteCategory?.entries.length ?? 0
            }
          )}
          confirmLabel={t('Delete category')}
          cancelLabel={t('Cancel')}
          onConfirm={() => {
            if (!pendingDeleteCategory) return
            void deleteCategory({
              id: pendingDeleteCategory.id,
              expectedRevision: pendingDeleteCategory.revision
            }).catch(() => undefined)
          }}
        />
      </div>
    </TooltipProvider>
  )
}

const MemoryPanel = ({ view, onNavigate, onOpenProject }: MemoryPanelProps): React.JSX.Element => {
  const categories = useMemoryStore((state) => state.categories)
  const status = useMemoryStore((state) => state.status)
  const customCategories = categories.filter(
    (category): category is CustomMemoryCategoryView => !isAboutYou(category)
  )
  const editing =
    view.kind === 'edit'
      ? customCategories.find((category) => category.id === view.categoryId)
      : undefined
  const missingEditTarget = view.kind === 'edit' && !editing

  useEffect(() => {
    if (missingEditTarget && status === 'ready') onNavigate({ kind: 'list' })
  }, [missingEditTarget, onNavigate, status])

  if (missingEditTarget) {
    return <MemoryList onNavigate={onNavigate} onOpenProject={onOpenProject} />
  }

  if (view.kind !== 'list') {
    return (
      <CategoryForm
        category={editing}
        customCount={customCategories.length}
        onCancel={() => onNavigate({ kind: 'list' })}
      />
    )
  }
  return <MemoryList onNavigate={onNavigate} onOpenProject={onOpenProject} />
}

export { MemoryPanel }
