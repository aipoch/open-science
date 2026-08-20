export const OPEN_NOTIFICATION_CENTER_EVENT = 'open-science:open-notification-center'
export const NOTIFICATION_CENTER_OPENED_EVENT = 'open-science:notification-center-opened'

export type OpenNotificationCenterDetail = Readonly<{ bellId?: string }>

export const isVisibleNotificationBell = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  )
}
