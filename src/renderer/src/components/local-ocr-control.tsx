import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, ScanText } from 'lucide-react'
import { Checkbox } from 'radix-ui'
import type { LocalModelSnapshot } from '../../../shared/local-models'
import { localModelDownloadProgress } from '../../../shared/local-models'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { DownloadProgressLine } from './DownloadProgressLine'

const size = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

const languageLabel = (
  code: NonNullable<LocalModelSnapshot['ocrLanguages']>[number]['code'],
  t: TFunction
): string => {
  switch (code) {
    case 'eng':
      return t('English', { context: 'language' })
    case 'chi_sim':
      return t('Simplified Chinese')
    case 'chi_tra':
      return t('Traditional Chinese')
    case 'deu':
      return t('German')
    case 'spa':
      return t('Spanish')
    case 'fra':
      return t('French')
    case 'jpn':
      return t('Japanese')
    case 'kor':
      return t('Korean')
    case 'rus':
      return t('Russian')
  }
}

export function LocalOcrControl({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>()
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [installedHere, setInstalledHere] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let installing = false
      try {
        const next = await window.api.localModels.getSnapshot('ocr')
        installing = next.availability === 'installing'
        if (live) {
          setSnapshot(next)
          setFailed(false)
        }
      } catch {
        if (live) setFailed(true)
      }
      if (live) timer = setTimeout(() => void poll(), installing ? 750 : 2500)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])
  const run = async (action: 'install' | 'cancel' | 'remove'): Promise<void> => {
    setPending(true)
    try {
      setSnapshot(await window.api.localModels[action]('ocr'))
      setFailed(false)
      if (action === 'install') setInstalledHere(true)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  const setLanguage = async (
    code: NonNullable<LocalModelSnapshot['ocrLanguages']>[number]['code'],
    selected: boolean
  ): Promise<void> => {
    if (!snapshot?.selectedOcrLanguages) return
    setPending(true)
    try {
      const languages = selected
        ? [...snapshot.selectedOcrLanguages, code]
        : snapshot.selectedOcrLanguages.filter((value) => value !== code)
      setSnapshot(await window.api.localModels.setOcrLanguages(languages))
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  const selectedLanguagesInstalled =
    !snapshot?.ocrLanguages ||
    snapshot.ocrLanguages
      .filter((language) => language.selected)
      .every((language) => language.installed)
  const installed = snapshot?.availability === 'ready' && selectedLanguagesInstalled
  const installing = snapshot?.availability === 'installing'
  if (compact && ((!snapshot && !failed) || (installed && !installedHere && !snapshot?.error)))
    return null
  return (
    <div
      className={compact ? 'space-y-2' : 'space-y-3 rounded-lg border border-border bg-card p-4'}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <ScanText className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium">{t('Text recognition (OCR)')}</span>
          {!compact && <span className="text-xs text-muted-foreground">{t('OCR languages')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {snapshot && !compact && (
            <span>{size(installed ? snapshot.installedBytes : snapshot.downloadBytes)}</span>
          )}
          {installing ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void run('cancel')}
            >
              {t('Cancel download')}
            </Button>
          ) : installed && !snapshot?.error && !snapshot?.updateAvailable ? (
            compact ? (
              <span role="status">{t('OCR installed. Read the PDF again.')}</span>
            ) : (
              <>
                <span role="status">{t('Installed')}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || snapshot.inUse}
                  onClick={() => void run('remove')}
                >
                  {t('Uninstall')}
                </Button>
              </>
            )
          ) : (
            <Button
              size="sm"
              disabled={
                pending ||
                !snapshot ||
                failed ||
                snapshot.error === 'incompatible' ||
                snapshot.inUse
              }
              onClick={() => void run('install')}
            >
              {snapshot?.error
                ? t('Retry')
                : snapshot?.updateAvailable
                  ? t('Update')
                  : t('Install')}
            </Button>
          )}
        </div>
      </div>
      {installing && snapshot && (
        <DownloadProgressLine progress={localModelDownloadProgress(snapshot)} />
      )}
      {!compact && snapshot?.ocrLanguages ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">
            {t('OCR languages')}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {snapshot.ocrLanguages.map((language) => {
              const label = languageLabel(language.code, t)
              return (
                <Checkbox.Root
                  key={language.code}
                  checked={language.selected}
                  disabled={pending || language.code === 'eng'}
                  aria-label={label}
                  onCheckedChange={(checked) => {
                    if (checked !== 'indeterminate') void setLanguage(language.code, checked)
                  }}
                  className="group flex min-h-8 items-center gap-2 rounded-md px-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded border border-border-100 bg-bg-000 text-text-000 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
                    <Checkbox.Indicator>
                      <Check className="size-3" aria-hidden="true" />
                    </Checkbox.Indicator>
                  </span>
                  <span>{label}</span>
                  {!language.installed ? (
                    <span className="text-xs text-muted-foreground">{t('Not installed')}</span>
                  ) : null}
                </Checkbox.Root>
              )
            })}
          </div>
        </fieldset>
      ) : null}
      {failed || snapshot?.error ? (
        <ErrorNotice
          inline
          tone="amber"
          description={
            failed
              ? t('Could not access local models. Open the local app and try again.')
              : snapshot?.error === 'integrity'
                ? t('Model verification failed. Retry to download a complete copy.')
                : snapshot?.error === 'incompatible'
                  ? t(
                      'These model files belong to an unsupported version. Update the app to manage them.'
                    )
                  : snapshot?.error === 'storage'
                    ? t(
                        'Model files could not be accessed. Check the data folder and available space.'
                      )
                    : t('Model download failed. Retry to resume when supported by the server.')
          }
        />
      ) : null}
    </div>
  )
}
