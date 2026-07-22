import { ExternalLink, FolderOpen, Globe, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import type { CliLauncherStatus } from '../../../../shared/cli'
import { APP } from '../../../../shared/app-config'
import { AppVersionSection } from './AppVersionSection'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// Community entry links (Discord, X) share the GitHub badge's compact look so the row reads as one
// set of "connect with the project" actions.
const socialLinkClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted hover:text-foreground'

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

// General app settings. Hosts the Diagnostics (log file) tools and the community/connect links. The log
// file stays on this device and is never transmitted by the app.
const GeneralPanel = (): React.JSX.Element => {
  const [logPath, setLogPath] = useState<string | null>(null)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [isOpening, setIsOpening] = useState(false)
  const [cli, setCli] = useState<CliLauncherStatus | null>(null)
  const [isUpdatingCli, setIsUpdatingCli] = useState(false)
  const [cliError, setCliError] = useState<string | undefined>(undefined)
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)

  useEffect(() => {
    void window.api.logs.getPath().then(setLogPath)
    void window.api.cli.getStatus().then(setCli)
  }, [])

  const handleCli = async (action: 'install' | 'uninstall'): Promise<void> => {
    setIsUpdatingCli(true)
    setCliError(undefined)

    try {
      setCli(
        action === 'install' ? await window.api.cli.install() : await window.api.cli.uninstall()
      )
    } catch (error) {
      setCliError(
        error instanceof Error ? error.message : 'Could not update the command-line tool.'
      )
    } finally {
      setIsUpdatingCli(false)
    }
  }

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

  const handleReveal = async (): Promise<void> => {
    setMessage(undefined)

    try {
      const result = await window.api.logs.revealInFolder()

      if (!result.revealed) {
        setMessage(result.error ?? 'Could not reveal the log file.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reveal the log file.')
    }
  }

  return (
    <div className="space-y-5 p-5">
      <AppVersionSection />

      <SettingsSection
        title="Notifications"
        description={
          <>
            Get a desktop notification when a task finishes, fails, or waits for your approval while
            you&apos;re away from the app. Selecting it brings Open Science back to the front and
            opens the task.
          </>
        }
        aria-label="Notifications"
        separated
      >
        <SettingsRow label="Task notifications" className="pt-0">
          <SettingsToggle
            enabled={notificationsEnabled}
            aria-label="Toggle task notifications"
            onToggle={() => void setNotificationsEnabled(!notificationsEnabled)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Diagnostics"
        description={
          <>
            View this device&apos;s runtime log — it records what the app is doing so problems can
            be diagnosed.
          </>
        }
        aria-label="Diagnostics"
        separated
      >
        <SettingsRow label="Log file" controlClassName="w-auto justify-self-end" className="pt-0">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleReveal()}
              disabled={!logPath}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Reveal
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleOpenLog()}
              disabled={isOpening || !logPath}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {isOpening ? 'Opening…' : 'Open'}
            </Button>
          </div>
        </SettingsRow>

        <pre
          className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
          aria-label="Log file path"
        >
          {logPath ?? 'Not available yet.'}
        </pre>

        {message ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {message}
          </p>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          Something not working?{' '}
          <ExternalTextLink href={APP.links.githubIssues}>Open an issue on GitHub</ExternalTextLink>{' '}
          and attach the log above. It stays on this device and is never sent automatically; it may
          contain local file paths, so review it before sharing.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Command line tool"
        description={
          <>
            Install the <code className="font-mono">open-science</code> command so you can start,
            stop, and check the backend from a terminal, then use it entirely from your browser.
          </>
        }
        aria-label="Command line tool"
        separated
      >
        <SettingsRow
          label="open-science"
          controlClassName="w-auto justify-self-end"
          className="pt-0"
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleCli(cli?.installed ? 'uninstall' : 'install')}
            disabled={isUpdatingCli || cli === null}
          >
            <Terminal className="size-4" aria-hidden="true" />
            {isUpdatingCli ? 'Working…' : cli?.installed ? 'Uninstall command' : 'Install command'}
          </Button>
        </SettingsRow>

        {cli?.installed ? (
          <pre
            className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
            aria-label="Command line tool path"
          >
            {cli.target}
          </pre>
        ) : null}

        {cli?.installed && cli.pathHint ? (
          <p className="mt-2 text-xs text-muted-foreground">{cli.pathHint}</p>
        ) : null}

        {cliError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {cliError}
          </p>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          Once installed, run <code className="font-mono">open-science start</code> to launch the
          backend and open the authenticated URL, then{' '}
          <code className="font-mono">open-science stop</code> to shut it down.{' '}
          <code className="font-mono">status</code> and <code className="font-mono">url</code> are
          also available.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Enjoying Open Science?"
        description={
          <>
            It&apos;s free and open source. Star it on GitHub to help others find it, and come build
            in public with us on Discord and X. Thanks for being here.
          </>
        }
        aria-label="Community"
        separated
      >
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
      </SettingsSection>
    </div>
  )
}

export { GeneralPanel }
