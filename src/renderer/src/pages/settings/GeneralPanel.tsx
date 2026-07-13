import { ExternalLink, Globe } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { APP } from '../../../../shared/app-config'

// Community entry links (Discord, X) share the GitHub badge's compact look so the row reads as one
// set of "connect with the project" actions.
const socialLinkClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000'

// Discord and X are brand marks that lucide-react dropped in v1, so we inline the official SVGs.
// currentColor lets them inherit the link's text color like the other icons.
const DiscordMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
  </svg>
)

const XMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </svg>
)

// General app settings. Hosts the diagnostics "Logs" option and the community/connect links. The log
// file stays on this device and is never transmitted by the app.
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
          Something not working as expected?{' '}
          <ExternalTextLink href={APP.links.githubIssues}>Open an issue on GitHub</ExternalTextLink>{' '}
          and attach the log above.
        </p>

        <p className="mt-3 text-xs text-muted-foreground">
          Logs are stored only on this device and are never sent anywhere by the app. The file may
          contain local file paths; review it before sharing.
        </p>
      </section>

      <section aria-label="Community">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Enjoying Open Science?</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          It&apos;s free and open source. Star it on GitHub to help others find it, and come build
          in public with us on Discord and X. Thanks for being here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <GitHubStarBadge className="border border-border" />
          <a
            href={APP.links.discord}
            target="_blank"
            rel="noreferrer"
            aria-label={`Join the ${APP.name} community on Discord`}
            className={socialLinkClassName}
          >
            <DiscordMark className="size-4" />
            Discord
          </a>
          <a
            href={APP.links.x}
            target="_blank"
            rel="noreferrer"
            aria-label={`Follow ${APP.name} on X`}
            className={socialLinkClassName}
          >
            <XMark className="size-4" />X
          </a>
          <a
            href={APP.links.website}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the ${APP.name} website`}
            className={socialLinkClassName}
          >
            <Globe className="size-4" strokeWidth={2} aria-hidden="true" />
            Website
          </a>
        </div>
      </section>
    </div>
  )
}

export { GeneralPanel }
