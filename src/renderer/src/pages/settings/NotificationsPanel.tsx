import { Check, CircleAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  NotificationDesktopAvailability,
  NotificationTestResult
} from '../../../../shared/notifications'
import { APP } from '../../../../shared/app-config'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// Notification probing and delivery controls live together so General does not initialize native
// notification APIs when the user only wants to inspect app maintenance settings.
const NotificationsPanel = (): React.JSX.Element => {
  const { t } = useTranslation()
  const [notificationAvailability, setNotificationAvailability] =
    useState<NotificationDesktopAvailability>('unavailable')
  const [notificationTestResult, setNotificationTestResult] = useState<NotificationTestResult>()
  const [isTestingNotification, setIsTestingNotification] = useState(false)
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const showNotificationContent = useSettingsStore((state) => state.showNotificationContent)
  const setShowNotificationContent = useSettingsStore((state) => state.setShowNotificationContent)

  useEffect(() => {
    const getAvailability = window.api.notifications.getDesktopAvailability
    if (!getAvailability) return
    void getAvailability()
      .then(setNotificationAvailability)
      .catch(() => setNotificationAvailability('unavailable'))
  }, [])

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

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        data-settings-anchor="notifications.preferences"
        title={t('Notifications')}
        description={t(
          "Get a desktop notification when a task finishes, fails, or waits for your approval while you're away from the app."
        )}
        aria-label={t('Notifications')}
      >
        <SettingsRow
          label={t('Task notifications')}
          description={t(
            'Selecting a notification brings {{appName}} back to the front and opens the task.',
            { appName: APP.name }
          )}
          className="pt-0"
        >
          <SettingsToggle
            enabled={notificationsEnabled}
            aria-label={t('Toggle task notifications')}
            onToggle={() => void setNotificationsEnabled(!notificationsEnabled)}
          />
        </SettingsRow>

        <SettingsRow
          label={t('Show task content in system notifications')}
          description={t(
            'Include task names and request details. Provider errors are always hidden.'
          )}
        >
          <SettingsToggle
            enabled={showNotificationContent}
            disabled={!notificationsEnabled}
            aria-label={t('Toggle task content in system notifications')}
            onToggle={() => void setShowNotificationContent(!showNotificationContent)}
          />
        </SettingsRow>

        <SettingsRow
          label={t('System notification status')}
          description={
            notificationAvailability === 'supported'
              ? t('System notifications are supported on this device.')
              : t('System notifications are unavailable on this device.')
          }
        >
          <div className="flex w-full flex-col items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={notificationAvailability !== 'supported' || isTestingNotification}
              onClick={() => void handleTestNotification()}
            >
              {isTestingNotification ? t('Sending test…') : t('Send test notification')}
            </Button>
            <div className="flex min-h-[30px] w-full items-start justify-end pt-1.5">
              <span
                role="status"
                className={cn(
                  'inline-flex items-center gap-[5px] rounded-lg border px-2 py-[3px] text-xs leading-[18px] font-medium whitespace-nowrap',
                  notificationTestResult === undefined
                    ? 'invisible'
                    : notificationTestResult === 'shown'
                      ? 'border-status-success-accent/30 bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground'
                      : notificationTestResult === 'unconfirmed'
                        ? 'border-status-warning-foreground/30 bg-status-warning-surface text-status-warning-foreground dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
                        : 'border-status-failure-border bg-status-failure-surface text-status-failure-foreground dark:border-status-failure-dark-border dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
                )}
              >
                {notificationTestResult === 'shown' || notificationTestResult === undefined ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : notificationTestResult === 'unconfirmed' ? (
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-3.5" aria-hidden="true" />
                )}
                {notificationTestResult === 'failed'
                  ? t('Test notification failed.')
                  : notificationTestResult === 'unconfirmed'
                    ? t('Test notification sent, but display could not be confirmed.')
                    : notificationTestResult === 'unavailable'
                      ? t('System notifications are unavailable on this device.')
                      : t('Test notification shown.')}
              </span>
            </div>
          </div>
        </SettingsRow>

        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "Notifications only appear while you're using another app. Tasks you cancel and failures the app retries automatically stay silent. Your operating system may ask for notification permission the first time one appears."
          )}
        </p>
      </SettingsSection>
    </div>
  )
}

export { NotificationsPanel }
