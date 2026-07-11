import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

// General app settings. Currently hosts the diagnostics "Logs" option; a home for future app-wide
// preferences. The log file stays on this device and is never transmitted by the app.
const GeneralPanel = (): React.JSX.Element => {
  const [logPath, setLogPath] = useState<string | null>(null)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [isOpening, setIsOpening] = useState(false)

  useEffect(() => {
    void window.api.logs.getPath().then(setLogPath)
  }, [])

  const handleOpenLog = async (): Promise<void> => {
    setIsOpening(true)
    setMessage(undefined)

    try {
      const result = await window.api.logs.openFile()

      if (!result.opened) {
        setMessage(result.error ?? 'Could not open the log file.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the log file.')
    } finally {
      setIsOpening(false)
    }
  }

  return (
    <div className="space-y-6 p-5">
      <section aria-label="Logs">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Logs</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          View the app&apos;s runtime log file. When something goes wrong, open it and attach it to
          your feedback so the issue can be diagnosed.
        </p>

        <div className="rounded-xl border border-border p-4">
          <span className="text-xs font-medium text-muted-foreground">Log file</span>
          <pre
            className="mt-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground"
            aria-label="Log file path"
          >
            {logPath ?? 'Not available yet.'}
          </pre>

          <button
            type="button"
            onClick={() => void handleOpenLog()}
            disabled={isOpening || !logPath}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            {isOpening ? 'Opening…' : 'Open log file'}
          </button>

          {message ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {message}
            </p>
          ) : null}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Logs are stored only on this device and are never sent anywhere by the app. The file may
          contain local file paths; review it before sharing.
        </p>
      </section>
    </div>
  )
}

export { GeneralPanel }
