import { createContext, useContext, useEffect } from 'react'

export type WindowsTitleBarCommands = {
  settingsEnabled: boolean
  searchEnabled: boolean
  openSettings: () => void
  openSearch: () => void
}

export const WindowsTitleBarContext = createContext<
  ((commands: WindowsTitleBarCommands | null) => void) | null
>(null)

// Presentation ownership stays in useApplicationEventBindings. The chrome starts with application
// commands disabled and receives only the current owner's guarded actions once that owner mounts.
export const useWindowsTitleBarCommands = (commands: WindowsTitleBarCommands): void => {
  const publish = useContext(WindowsTitleBarContext)
  const { settingsEnabled, searchEnabled, openSettings, openSearch } = commands
  useEffect(() => {
    publish?.({ settingsEnabled, searchEnabled, openSettings, openSearch })
    return () => publish?.(null)
  }, [publish, settingsEnabled, searchEnabled, openSettings, openSearch])
}
