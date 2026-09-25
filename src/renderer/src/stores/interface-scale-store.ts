import { create } from 'zustand'

import {
  applyInterfaceScale,
  INTERFACE_SCALE_STORAGE_KEY,
  persistInterfaceScale,
  resolveInterfaceScale,
  type InterfaceScale
} from '@/lib/interface-scale'

type InterfaceScaleStore = {
  scale: InterfaceScale
  setScale: (scale: InterfaceScale) => void
}

const initialScale = resolveInterfaceScale()

export const useInterfaceScaleStore = create<InterfaceScaleStore>((set) => {
  const applyPreference = (scale: InterfaceScale): void => {
    void applyInterfaceScale(scale)
    set({ scale })
  }

  const onStorage = (event: StorageEvent): void => {
    if (
      event.storageArea !== localStorage ||
      (event.key !== null && event.key !== INTERFACE_SCALE_STORAGE_KEY)
    )
      return

    applyPreference(resolveInterfaceScale())
  }

  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  const removeShortcut =
    typeof window !== 'undefined'
      ? window.api?.window?.onInterfaceScaleShortcut?.((scale) => {
          applyPreference(scale)
          persistInterfaceScale(scale)
        })
      : undefined
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('storage', onStorage)
      removeShortcut?.()
    })
  }

  return {
    scale: initialScale,
    setScale: (scale) => {
      applyPreference(scale)
      persistInterfaceScale(scale)
    }
  }
})
