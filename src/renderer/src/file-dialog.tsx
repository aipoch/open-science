import { useEffect, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { Folder, ArrowUp, ChevronDown, X } from 'lucide-react'
import type {
  FileDialogUiAction,
  FileDialogUiBridge,
  FileDialogUiError,
  FileDialogUiState
} from '../../shared/file-dialog-ui'
import { matchingFileExtension } from '../../shared/file-save-name'
import { initI18n, prepareI18nLocale } from './i18n'
import { ErrorNotice } from './components/error-notice'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import * as AlertDialog from './components/ui/alert-dialog'
import {
  dialogHeaderClassName,
  dialogBodyClassName,
  dialogTitleClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogCancelButtonClassName,
  dialogPanelClassName,
  dialogOverlayClassName
} from './components/ui/dialog-chrome'
import { applyTheme, subscribeSystemTheme } from './lib/theme'
import './assets/main.css'

declare global {
  interface Window {
    fileDialog: FileDialogUiBridge
  }
}

export function FileDialog({ initial }: { initial: FileDialogUiState }): JSX.Element {
  const { t } = useTranslation()
  const directoryMode = initial.mode === 'directory'
  const [location, setLocation] = useState(initial.location)
  const [path, setPath] = useState(initial.location.path)
  const [filename, setFilename] = useState(initial.filename)
  const [browsing, setBrowsing] = useState(directoryMode)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<FileDialogUiError | null>(null)
  const [errorOwner, setErrorOwner] = useState<'path' | 'name' | 'new-folder' | 'destination'>(
    'destination'
  )
  const [suggestedName, setSuggestedName] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ token: string; filename: string } | null>(null)
  const expanded = browsing
  const filenameError = errorOwner === 'name' ? error : null
  const pathError = errorOwner === 'path' ? error : null
  const newFolderError = newFolder !== null && errorOwner === 'new-folder' ? error : null
  const destinationError = errorOwner === 'destination' ? error : null
  const formatLabel = initial.format
    ? `${initial.format.name || t('Original file')} (${initial.format.extensions.map((extension) => `.${extension}`).join(', ')})`
    : t('Original file')
  const errors: Record<FileDialogUiError, string> = {
    folder: t('Cannot open this folder. Check the path and permissions.'),
    filename: t('Enter a valid file name.'),
    extension: t('File type: {{type}}; suggested name: “{{name}}”.', {
      type: formatLabel,
      name: suggestedName ?? filename
    }),
    destination: t('Cannot use this destination. Choose another file or folder.'),
    changed: t('The destination changed. Review it and save again.')
  }
  const editName = (name: string): void => {
    setFilename(name)
    setError(null)
    setSuggestedName(null)
  }
  const selectStem = (): void => {
    const input = nameInput.current
    if (!input) return
    const suffix = matchingFileExtension(input.value, initial.format?.extensions ?? [])
    input.setSelectionRange(0, suffix ? input.value.length - suffix.length - 1 : input.value.length)
  }
  useEffect(() => {
    // Keep the extension visible and select only the stem for the common rename gesture.
    selectStem()
    void window.fileDialog
      .action({ type: 'ready' })
      .then(() => {
        setReady(true)
      })
      .catch(() => window.fileDialog.action({ type: 'failed' }))
    if (initial.appearance.followsSystem) return subscribeSystemTheme(applyTheme)
    return undefined
    // The initial snapshot is immutable for the lifetime of this helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!ready) return
    void window.fileDialog.action({ type: 'resize', expanded }).catch(() => undefined)
  }, [expanded, ready])
  const run = async (action: FileDialogUiAction): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    setSuggestedName(null)
    setConfirmation(null)
    try {
      const reply = await window.fileDialog.action(action)
      if (reply.type === 'browse') {
        setNewFolder(null)
        setLocation(reply.location)
        setPath(reply.location.path)
      } else if (reply.type === 'confirm') setConfirmation(reply)
      else if (reply.type === 'error') {
        setError(reply.code)
        // The same validation code can belong to different fields, especially in directory mode.
        setErrorOwner(
          action.type === 'mkdir'
            ? 'new-folder'
            : reply.code === 'folder'
              ? 'path'
              : reply.code === 'filename' || reply.code === 'extension'
                ? 'name'
                : 'destination'
        )
        setSuggestedName(reply.suggestions?.keep ?? null)
      }
    } catch {
      setError('destination')
      setErrorOwner(action.type === 'mkdir' ? 'new-folder' : 'destination')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = (): void => {
    void run({ type: 'select', directory: path, filename })
  }
  const inputClass = `${dialogFormInputClassName} h-9`
  const rowClass = 'grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3'
  return (
    <main
      className="flex h-full min-h-0 flex-col bg-card text-foreground"
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault()
          if (confirmation) setConfirmation(null)
          else void run({ type: 'cancel' })
        }
      }}
    >
      <header className={dialogHeaderClassName}>
        <h1 className={dialogTitleClassName}>
          {directoryMode ? t('Select folder') : t('Save file')}
        </h1>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={t('Close')}
          disabled={busy}
          onClick={() => void run({ type: 'cancel' })}
        >
          <X className="size-4" />
        </Button>
      </header>
      <fieldset
        disabled={busy || Boolean(confirmation)}
        className={`${dialogBodyClassName} flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto`}
      >
        <div className="flex shrink-0 flex-col gap-1.5">
          <div className={rowClass}>
            <label htmlFor="save-path" className="text-sm text-muted-foreground">
              {t('Save path')}
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                id="save-path"
                className={inputClass}
                value={path}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={Boolean(pathError)}
                aria-describedby={pathError ? 'save-path-hint' : undefined}
                onChange={(event) => {
                  setPath(event.target.value)
                  setError(null)
                  setSuggestedName(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  setBrowsing(true)
                  void run({ type: 'browse', path })
                }}
              />
              <Button
                variant="outline"
                className="h-9 shrink-0"
                aria-expanded={browsing}
                aria-controls="folder-browser"
                onClick={() => {
                  setBrowsing(!browsing)
                  if (!browsing) void run({ type: 'browse', path })
                }}
              >
                {t('Browse')}
                <ChevronDown className={`size-4 ${browsing ? 'rotate-180' : ''}`} />
              </Button>
            </div>
          </div>
          {pathError && (
            <div className={rowClass}>
              <span aria-hidden="true" />
              <p
                id="save-path-hint"
                role="alert"
                className="text-sm leading-5 text-muted-foreground"
              >
                {errors[pathError]}
              </p>
            </div>
          )}
        </div>
        {browsing && (
          <section
            id="folder-browser"
            className="min-h-36 shrink-0 overflow-hidden rounded-lg border border-border bg-background"
            aria-label={t('Folders')}
          >
            <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                disabled={location.parent === location.path}
                onClick={() => void run({ type: 'browse', path: location.parent })}
              >
                <ArrowUp className="size-4" />
                {t('Parent folder')}
              </Button>
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={location.path}
              >
                {location.path}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setNewFolder('')}>
                {t('New folder')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('Hide folders')}
                onClick={() => setBrowsing(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            {newFolder !== null && (
              <form
                className="flex flex-col gap-1.5 px-2 pt-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run({ type: 'mkdir', directory: location.path, name: newFolder })
                }}
              >
                <div className="flex gap-2">
                  <Input
                    className={inputClass}
                    autoFocus
                    aria-label={t('Folder name')}
                    value={newFolder}
                    aria-invalid={Boolean(newFolderError)}
                    aria-describedby={newFolderError ? 'new-folder-hint' : undefined}
                    onChange={(event) => {
                      setNewFolder(event.target.value)
                      setError(null)
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        (event.nativeEvent.isComposing || event.keyCode === 229)
                      )
                        event.preventDefault()
                    }}
                  />
                  <Button type="submit" variant="outline">
                    {t('Create')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setNewFolder(null)
                      setError(null)
                    }}
                  >
                    {t('Cancel')}
                  </Button>
                </div>
                {newFolderError && (
                  <p
                    id="new-folder-hint"
                    role="alert"
                    className="text-sm leading-5 text-muted-foreground"
                  >
                    {newFolderError === 'filename'
                      ? t('Enter a valid folder name.')
                      : errors[newFolderError]}
                  </p>
                )}
              </form>
            )}
            <div className="max-h-44 overflow-y-auto p-1">
              {location.folders.map((folder) => (
                <button
                  type="button"
                  key={folder.path}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-ring"
                  onClick={() => void run({ type: 'browse', path: folder.path })}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{folder.name}</span>
                </button>
              ))}
              {location.folders.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">{t('No subfolders')}</p>
              )}
            </div>
            {location.truncated && (
              <p className="p-2 text-xs text-muted-foreground">
                {t('Some folders are not listed. Enter the folder path to open them.')}
              </p>
            )}
          </section>
        )}
        {!directoryMode && (
          <div className="flex shrink-0 flex-col gap-1.5">
            <div className={rowClass}>
              <label htmlFor="save-name" className="text-sm text-muted-foreground">
                {t('File name')}
              </label>
              <Input
                id="save-name"
                ref={nameInput}
                className={inputClass}
                autoFocus
                value={filename}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={Boolean(filenameError)}
                aria-describedby={filenameError ? 'save-name-hint' : undefined}
                onChange={(event) => editName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  // Enter commits an IME candidate without accepting or saving the file.
                  if (!event.nativeEvent.isComposing && event.keyCode !== 229) save()
                }}
              />
            </div>
            {filenameError && (
              <div className={rowClass}>
                <span aria-hidden="true" />
                <div>
                  {filenameError && (
                    <p
                      id="save-name-hint"
                      role="alert"
                      className="text-sm font-normal leading-5 text-muted-foreground [overflow-wrap:anywhere]"
                    >
                      {errors[filenameError]}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {/* Reuse the body's remaining space; never append feedback after an empty spacer. */}
        {destinationError && (
          <div className="shrink-0" id="save-destination-hint">
            <ErrorNotice inline description={errors[destinationError]} role="alert" level="error" />
          </div>
        )}
      </fieldset>
      <footer className={`${dialogFooterClassName} bg-background`}>
        <Button
          variant="ghost"
          className={dialogCancelButtonClassName}
          disabled={busy}
          onClick={() => void run({ type: 'cancel' })}
        >
          {t('Cancel')}
        </Button>
        <Button disabled={busy} onClick={save}>
          {directoryMode ? initial.buttonLabel || t('Select folder') : t('Save')}
        </Button>
      </footer>
      <AlertDialog.Root
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[calc(100%-2rem)] max-w-md p-0')}
            onEscapeKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229) event.preventDefault()
            }}
          >
            <div className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Replace existing file?')}
              </AlertDialog.Title>
            </div>
            <AlertDialog.Description className={dialogBodyClassName}>
              {t('“{{name}}” already exists. Replace it?', { name: confirmation?.filename ?? '' })}
            </AlertDialog.Description>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" className={dialogCancelButtonClassName} disabled={busy}>
                  {t('Keep existing file')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                disabled={busy}
                onClick={() => {
                  if (confirmation) void run({ type: 'replace', token: confirmation.token })
                }}
              >
                {t('Replace')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </main>
  )
}

async function start(): Promise<void> {
  const reply = await window.fileDialog.action({ type: 'init' })
  if (reply.type !== 'init') throw new Error('File dialog initialization failed')
  applyTheme(reply.state.appearance.theme)
  await prepareI18nLocale(reply.state.locale)
  initI18n(reply.state.locale)
  document.documentElement.lang = reply.state.locale
  createRoot(document.getElementById('root')!).render(<FileDialog initial={reply.state} />)
}
void start().catch(() => window.fileDialog.action({ type: 'failed' }))
