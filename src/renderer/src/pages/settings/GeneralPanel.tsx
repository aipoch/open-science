import { ExternalLink, FolderOpen, Globe, Terminal } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { LanguageSelect } from '@/components/LanguageControls'
import { ThemeSegmentedControl } from '@/components/ThemeControls'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { errorDetail } from '@/lib/error-detail'
import { useSettingsStore } from '@/stores/settings-store'
import type { CloseActionPreference } from '../../../../shared/window-controls'
import type { CliLauncherStatus } from '../../../../shared/cli'
import type { LogFileStatus } from '../../../../shared/logs'
import { APP } from '../../../../shared/app-config'
import type {
  NotificationDesktopAvailability,
  NotificationTestResult
} from '../../../../shared/notifications'
import { AppIconSection } from './AppIconSection'
import { AppVersionSection } from './AppVersionSection'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// Community entry links (Discord, X) share the GitHub badge's compact look so the row reads as one
// set of "connect with the project" actions.
const socialLinkClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted hover:text-foreground'

type GeneralActionError = {
  action: 'cli' | 'cli-status' | 'open-log' | 'reveal-log'
  detail?: string
}

const generalActionErrorCopy = (error: GeneralActionError, t: TFunction): string => {
  switch (error.action) {
    case 'cli':
      return t('Could not update the command-line tool.')
    case 'cli-status':
      return t('Could not check the command-line tool.')
    case 'open-log':
      return t('Could not open the log file.')
    case 'reveal-log':
      return t('Could not reveal the log file.')
  }
}

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
  const { t } = useTranslation()
  const isMac = window.api.platform === 'darwin'
  const [logStatus, setLogStatus] = useState<LogFileStatus | null>(null)
  const [message, setMessage] = useState<GeneralActionError | undefined>(undefined)
  const [isOpening, setIsOpening] = useState(false)
  const [cli, setCli] = useState<CliLauncherStatus | null>(null)
  const [isUpdatingCli, setIsUpdatingCli] = useState(false)
  const [cliError, setCliError] = useState<GeneralActionError | undefined>(undefined)
  const [notificationAvailability, setNotificationAvailability] =
    useState<NotificationDesktopAvailability>('unavailable')
  const [notificationTestResult, setNotificationTestResult] = useState<NotificationTestResult>()
  const [isTestingNotification, setIsTestingNotification] = useState(false)
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const showNotificationContent = useSettingsStore((state) => state.showNotificationContent)
  const setShowNotificationContent = useSettingsStore((state) => state.setShowNotificationContent)
  const closePreference = useSettingsStore((state) => state.closePreference)
  const setClosePreference = useSettingsStore((state) => state.setClosePreference)

  const checkCliStatus = async (): Promise<void> => {
    setIsUpdatingCli(true)

    try {
      setCli(await window.api.cli.getStatus())
      setCliError(undefined)
    } catch (error) {
      setCliError({ action: 'cli-status', detail: errorDetail(error) })
    } finally {
      setIsUpdatingCli(false)
    }
  }

  useEffect(() => {
    void window.api.logs.getStatus().then(setLogStatus, () => setLogStatus(null))
    void window.api.cli.getStatus().then(setCli, (error) => {
      setCliError({ action: 'cli-status', detail: errorDetail(error) })
    })
    const getAvailability = window.api.notifications.getDesktopAvailability
    if (getAvailability) {
      void getAvailability()
        .then(setNotificationAvailability)
        .catch(() => {
          setNotificationAvailability('unavailable')
        })
    }
  }, [])

  const logPath = logStatus?.path ?? null
  const logExists = logStatus?.existing === true

  const handleTestNotification = async (): Promise<void> => {
    const sendTest = window.api.notifications.sendTest
    if (!sendTest) return

    setIsTestingNotification(true)
    setNotificationTestResult(undefined)
    try {
      setNotificationTestResult(await sendTest())
    } catch {
      setNotificationTestResult('failed')
    } finally {
      setIsTestingNotification(false)
    }
  }

  const handleCli = async (action: 'install' | 'uninstall'): Promise<void> => {
    setIsUpdatingCli(true)
    setCliError(undefined)

    try {
      setCli(
        action === 'install' ? await window.api.cli.install() : await window.api.cli.uninstall()
      )
    } catch (error) {
      setCliError({ action: 'cli', detail: errorDetail(error) })
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
        setMessage({ action: 'open-log', detail: result.error })
      }
    } catch (error) {
      setMessage({ action: 'open-log', detail: errorDetail(error) })
    } finally {
      setIsOpening(false)
    }
  }

  const handleReveal = async (): Promise<void> => {
    setMessage(undefined)

    try {
      const result = await window.api.logs.revealInFolder()

      if (!result.revealed) {
        setMessage({ action: 'reveal-log', detail: result.error })
      }
    } catch (error) {
      setMessage({ action: 'reveal-log', detail: errorDetail(error) })
    }
  }

  return (
    <div className="space-y-5 p-5">
      <AppVersionSection />

      <SettingsSection
        title={t('Appearance')}
        description={t(
          'Choose how the app looks and reads. System follows your device; the other choices stay fixed. Your selection is remembered on this device.'
        )}
        aria-label={t('Appearance')}
        separated
      >
        <SettingsRow
          label={t('Theme')}
          description={
            isMac
              ? t(
                  'Follow the system setting, or force light or dark. The Dock icon follows the resolved theme.'
                )
              : t('Follow the system setting, or force light or dark.')
          }

          className="pt-0"
          controlClassName="flex justify-end"
        >
          <ThemeSegmentedControl />
        </SettingsRow>

        <SettingsRow
          label={t('Language')}
          description={t(
            'Follow the system setting, or pick a language. System is detected once at startup, so a change to your device language takes effect the next time the app opens.'
          )}
        >
          <LanguageSelect />
        </SettingsRow>
      </SettingsSection>

      {window.api.platform === 'win32' && window.api.window?.onCloseConfirmRequest ? (
        <SettingsSection
          title={t('Window behavior')}
          description={t('Choose what the titlebar close button does.')}
          aria-label={t('Window behavior')}
          separated
        >
          <SettingsRow
            label={t('When closing the window')}
            description={t(
              'Ask each time, keep {{appName}} running in the tray, or quit the app.',
              {
                appName: APP.name
              }
            )}
            className="pt-0"
          >
            <Select
              value={closePreference ?? 'ask'}
              onValueChange={(value) =>
                void setClosePreference(
                  value === 'ask' ? undefined : (value as CloseActionPreference)
                )
              }
            >
              <SelectTrigger aria-label={t('When closing the window')}>
                <span>
                  {closePreference === 'minimize'
                    ? t('Minimize to tray')
                    : closePreference === 'quit'
                      ? t('Quit')
                      : t('Ask every time')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">{t('Ask every time')}</SelectItem>
                <SelectItem value="minimize">{t('Minimize to tray')}</SelectItem>
                <SelectItem value="quit">{t('Quit')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('Notifications')}
        description={t(
          "Get a desktop notification when a task finishes, fails, or waits for your approval while you're away from the app."
        )}
        aria-label={t('Notifications')}
        separated
      >
        <SettingsRow
          label={t('Task notifications')}
          description={t(
            'Selecting a notification brings {{appName}} back to the front and opens the task.',
            {
              appName: APP.name
            }
          )}
          className="pt-0"
        >
          <div className="flex justify-end">
            <SettingsToggle
              enabled={notificationsEnabled}
              aria-label={t('Toggle task notifications')}
              onToggle={() => void setNotificationsEnabled(!notificationsEnabled)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          label={t('Show task content in system notifications')}
          description={t(
            'Include task names and request details. Provider errors are always hidden.'
          )}
        >
          <div className="flex justify-end">
            <SettingsToggle
              enabled={showNotificationContent}
              disabled={!notificationsEnabled}
              aria-label={t('Toggle task content in system notifications')}
              onToggle={() => void setShowNotificationContent(!showNotificationContent)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          label={t('System notification status')}
          description={
            notificationAvailability === 'supported'
              ? t('System notifications are supported on this device.')
              : t('System notifications are unavailable on this device.')
          }
        >
          <div className="flex flex-col items-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={notificationAvailability !== 'supported' || isTestingNotification}
              onClick={() => void handleTestNotification()}
            >
              {isTestingNotification ? t('Sending test…') : t('Send test notification')}
            </Button>
            {notificationTestResult ? (
              <p className="text-right text-xs text-muted-foreground" role="status">
                {notificationTestResult === 'shown'
                  ? t('Test notification shown.')
                  : notificationTestResult === 'failed'
                    ? t('Test notification failed.')
                    : notificationTestResult === 'unconfirmed'
                      ? t('Test notification sent, but display could not be confirmed.')
                      : t('System notifications are unavailable on this device.')}
              </p>
            ) : null}
          </div>
        </SettingsRow>

        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "Notifications only appear while you're using another app. Tasks you cancel and failures the app retries automatically stay silent. Your operating system may ask for notification permission the first time one appears."
          )}
        </p>
      </SettingsSection>

      {/* macOS uses the adaptive build/icon.icon for the installed app and binds its live Dock icon
          to Theme. Hiding the independent picker prevents two controls from racing each other. */}
      {!isMac ? <AppIconSection /> : null}

      <SettingsSection
        title={t('Diagnostics')}
        description={t(
          "View this device's runtime log — it records what the app is doing so problems can be diagnosed."
        )}
        aria-label={t('Diagnostics')}
        separated
      >
        <SettingsRow
          label={t('Log file')}
          controlClassName="w-auto justify-self-end"
          className="pt-0"
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleReveal()}
              disabled={!logExists}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              {t('Reveal')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleOpenLog()}
              disabled={isOpening || !logExists}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {isOpening ? t('Opening…') : t('Open')}
            </Button>
          </div>
        </SettingsRow>

        <pre
          className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
          aria-label={t('Log file path')}
        >
          {logPath ?? t('Not available yet.')}
        </pre>

        {logStatus?.lastWriteSucceeded === false ? (
          <p className="mt-2 text-xs text-destructive" role="status">
            {t('The app could not write to the log file during its most recent attempt.')}
          </p>
        ) : null}

        {message ? (
          <div className="mt-2">
            <p className="text-xs text-destructive" role="alert">
              {generalActionErrorCopy(message, t)}
            </p>
            <DiagnosticDetails detail={message.detail} />
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          {/* Trans clones each component and injects the translated text as its children, so the
              empty string here is only satisfying the required prop — it never renders. */}
          <Trans
            i18nKey="Something not working? <docsLink>Open an issue on GitHub</docsLink> and attach the log above. It stays on this device and is never sent automatically; it may contain local file paths, so review it before sharing."
            components={{
              // Named docsLink, not link: <link> is a void HTML element, so the parser Trans uses
              // self-closes it and the label would render as a sibling of an empty anchor.
              docsLink: <ExternalTextLink href={APP.links.githubIssues}>{''}</ExternalTextLink>
            }}
          />
        </p>
      </SettingsSection>

      <SettingsSection
        title={t('Command line tool')}
        description={
          <Trans
            i18nKey="Install the <code>open-science</code> command so you can start, stop, and check the backend from a terminal, then use it entirely from your browser."
            components={{ code: <code className="font-mono" /> }}
          />
        }
        aria-label={t('Command line tool')}
        separated
      >
        <SettingsRow
          label={t('open-science')}
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
            {isUpdatingCli
              ? t('Working…')
              : cli?.installed
                ? t('Uninstall command')
                : t('Install command')}
          </Button>
        </SettingsRow>

        {cli?.installed ? (
          <pre
            className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
            aria-label={t('Command line tool path')}
          >
            {cli.target}
          </pre>
        ) : null}

        {cli?.installed && cli.pathHint ? (
          <p className="mt-2 text-xs text-muted-foreground">{cli.pathHint}</p>
        ) : null}

        {cliError ? (
          <div className="mt-2">
            <p className="text-xs text-destructive" role="alert">
              {generalActionErrorCopy(cliError, t)}
            </p>
            <DiagnosticDetails detail={cliError.detail} />
            {cliError.action === 'cli-status' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={isUpdatingCli}
                onClick={() => void checkCliStatus()}
              >
                {isUpdatingCli ? t('Checking…') : t('Check again')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          <Trans
            i18nKey="Once installed, run <code>open-science start</code> to launch the backend and open the authenticated URL, then <code>open-science stop</code> to shut it down. <code>status</code> and <code>url</code> are also available."
            components={{ code: <code className="font-mono" /> }}
          />
        </p>
      </SettingsSection>

      <SettingsSection
        title={t('Enjoying {{appName}}?', { appName: APP.name })}
        description={t(
          "It's free and open source. Star it on GitHub to help others find it, and come build in public with us on Discord and X. Thanks for being here."
        )}
        aria-label={t('Community')}
        separated
      >
        <div className="flex flex-wrap items-center gap-2">
          <GitHubStarBadge className="border border-border" />
          <a
            href={APP.links.discord}
            target="_blank"
            rel="noreferrer"
            aria-label={t('Join the {{appName}} community on Discord', { appName: APP.name })}
            className={socialLinkClassName}
          >
            <DiscordMark className="size-4" />
            Discord
          </a>
          <a
            href={APP.links.x}
            target="_blank"
            rel="noreferrer"
            aria-label={t('Follow {{appName}} on X', { appName: APP.name })}
            className={socialLinkClassName}
          >
            <XMark className="size-4" />X
          </a>
          <a
            href={APP.links.website}
            target="_blank"
            rel="noreferrer"
            aria-label={t('Open the {{appName}} website', { appName: APP.name })}
            className={socialLinkClassName}
          >
            <Globe className="size-4" strokeWidth={2} aria-hidden="true" />
            {t('Website')}
          </a>
        </div>
      </SettingsSection>
    </div>
  )
}

export { GeneralPanel }
