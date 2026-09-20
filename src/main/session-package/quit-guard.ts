import { currentApplicationShutdownTrigger } from '../application-shutdown-trigger'

type QuitEvent = { defaultPrevented?: boolean; preventDefault: () => void }

export const installSessionPackageQuitGuard = (
  app: {
    on: (name: 'before-quit', listener: (event: QuitEvent) => void) => unknown
    removeListener: (name: 'before-quit', listener: (event: QuitEvent) => void) => unknown
  },
  active: () => boolean,
  onBlocked: () => void
): (() => void) => {
  const beforeQuit = (event: QuitEvent): void => {
    if (event.defaultPrevented || !active() || currentApplicationShutdownTrigger() !== 'quit')
      return
    event.preventDefault()
    onBlocked()
  }
  app.on('before-quit', beforeQuit)
  return () => {
    app.removeListener('before-quit', beforeQuit)
  }
}
