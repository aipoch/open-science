import { useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { Folder, ArrowUp } from 'lucide-react'
import type {
  FileDialogUiAction,
  FileDialogUiBridge,
  FileDialogUiError,
  FileDialogUiState
} from '../../shared/file-dialog-ui'
import { initI18n, prepareI18nLocale } from './i18n'
import { ErrorNotice } from './components/error-notice'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import './assets/main.css'

declare global {
  interface Window {
    fileDialog: FileDialogUiBridge
  }
}

export function FileDialog({ initial }: { initial: FileDialogUiState }): JSX.Element {
  const { t } = useTranslation()
  const [location, setLocation] = useState(initial.location)
  const [path, setPath] = useState(initial.location.path)
  const [filename, setFilename] = useState(initial.filename)
  const [filterIndex, setFilterIndex] = useState(() =>
    Math.max(
      0,
      initial.filters.findIndex((filter) =>
        filter.extensions.some(
          (extension) =>
            extension !== '*' &&
            initial.filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
        )
      )
    )
  )
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<FileDialogUiError | null>(null)
  const [confirmation, setConfirmation] = useState<{ token: string; filename: string } | null>(null)
  const directoryMode = initial.mode === 'directory'
  const errors: Record<FileDialogUiError, string> = {
    folder: t('Cannot open this folder. Check the path and permissions.'),
    filename: t('Enter a valid Windows file name.'),
    extension: t('Use an extension matching the selected file type.'),
    destination: t('Cannot use this destination. Choose another file or folder.'),
    changed: t('The destination changed. Review it and save again.')
  }
  const run = async (action: FileDialogUiAction): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    setConfirmation(null)
    try {
      const reply = await window.fileDialog.action(action)
      if (reply.type === 'browse') {
        setNewFolder(null)
        setLocation(reply.location)
        setPath(reply.location.path)
      } else if (reply.type === 'confirm') setConfirmation(reply)
      else if (reply.type === 'error') setError(reply.code)
    } catch {
      setError('destination')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <main
      className="flex h-screen flex-col gap-4 bg-background p-6 text-foreground"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          if (confirmation) setConfirmation(null)
          else void run({ type: 'cancel' })
        }
      }}
    >
      <h1 className="text-lg font-semibold">
        {initial.title || (directoryMode ? t('Select folder') : t('Save file'))}
      </h1>
      <fieldset
        disabled={busy || Boolean(confirmation)}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run({ type: 'browse', path })
          }}
        >
          <Button
            type="button"
            variant="outline"
            aria-label={t('Parent folder')}
            onClick={() => void run({ type: 'browse', path: location.parent })}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Input
            aria-label={t('Folder path')}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if ((event.nativeEvent.isComposing || event.keyCode === 229) && event.key === 'Enter')
                event.preventDefault()
            }}
          />
          <Button type="submit" variant="outline">
            {t('Go')}
          </Button>
        </form>
        <div className="flex gap-2">
          {initial.shortcuts.map((item) => (
            <Button
              key={item.kind}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void run({ type: 'browse', path: item.path })}
            >
              {item.kind === 'downloads'
                ? t('Downloads')
                : item.kind === 'desktop'
                  ? t('Desktop')
                  : t('Home')}
            </Button>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setNewFolder('')}>
            {t('New folder')}
          </Button>
        </div>
        {newFolder !== null && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run({ type: 'mkdir', directory: path, name: newFolder })
            }}
          >
            <Input
              autoFocus
              aria-label={t('Folder name')}
              value={newFolder}
              onChange={(event) => setNewFolder(event.target.value)}
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
            <Button type="button" variant="ghost" onClick={() => setNewFolder(null)}>
              {t('Cancel')}
            </Button>
          </form>
        )}
        <div
          className="min-h-0 flex-1 overflow-auto rounded-md border p-2"
          aria-label={t('Folders')}
        >
          {location.folders.map((folder) => (
            <button
              type="button"
              key={folder.path}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-accent focus-visible:outline-ring"
              onClick={() => void run({ type: 'browse', path: folder.path })}
            >
              <Folder className="size-4 shrink-0" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
          {location.folders.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">{t('No subfolders')}</p>
          )}
        </div>
        {location.truncated && (
          <p className="text-sm text-muted-foreground">
            {t('Some folders are not listed. Enter the folder path to open them.')}
          </p>
        )}
        {!directoryMode && (
          <>
            <label className="flex flex-col gap-2 text-sm">
              {t('File name')}
              <Input
                autoFocus
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                onKeyDown={(event) => {
                  // Enter used to commit IME composition must never submit or accept replacement.
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    void run({ type: 'select', directory: path, filename, filterIndex })
                  }
                }}
              />
            </label>
            {initial.filters.length > 0 && (
              <label className="flex items-center gap-3 text-sm">
                {t('File type')}
                <select
                  className="min-w-0 flex-1 rounded-md border bg-background p-2"
                  value={filterIndex}
                  onChange={(event) => setFilterIndex(Number(event.target.value))}
                >
                  {initial.filters.map((filter, index) => (
                    <option key={index} value={index}>
                      {filter.name} (
                      {filter.extensions.map((extension) => `*.${extension}`).join(', ')})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
      </fieldset>
      {error && <ErrorNotice inline title={errors[error]} />}
      {confirmation ? (
        <section
          role="alertdialog"
          aria-label={t('Replace existing file?')}
          className="flex flex-col gap-3 rounded-md border p-4"
        >
          <p>{t('“{{name}}” already exists. Replace it?', { name: confirmation.filename })}</p>
          <div className="flex justify-end gap-2">
            <Button
              autoFocus
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              {t('Keep existing file')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void run({ type: 'replace', token: confirmation.token })}
            >
              {t('Replace')}
            </Button>
          </div>
        </section>
      ) : (
        <footer className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void run({ type: 'cancel' })}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run({ type: 'select', directory: path, filename, filterIndex })}
          >
            {initial.buttonLabel || (directoryMode ? t('Select folder') : t('Save'))}
          </Button>
        </footer>
      )}
    </main>
  )
}

async function start(): Promise<void> {
  const reply = await window.fileDialog.action({ type: 'init' })
  if (reply.type !== 'init') throw new Error('File dialog initialization failed')
  await prepareI18nLocale(reply.state.locale)
  initI18n(reply.state.locale)
  document.documentElement.lang = reply.state.locale
  createRoot(document.getElementById('root')!).render(<FileDialog initial={reply.state} />)
}
// Fail the helper rather than leave a blank, apparently working destination window.
void start().catch(() => window.fileDialog.action({ type: 'failed' }))
