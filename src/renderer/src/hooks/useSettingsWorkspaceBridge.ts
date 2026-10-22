import { useEffect } from 'react'
import { useNavigationStore } from '@/stores/navigation-store'
import type { CustomizeGoal } from '@/lib/customize-chat'
import type { ComposerDoc } from '@/pages/workspace/composer/composer-doc'
import type { PdfAnnotation } from '../../../shared/pdf-annotations'

// Navigation is executed by the workspace owner so its leave guards, session selection and drafts
// remain authoritative. A deferred guard hides Settings only when navigation actually commits.
export const useSettingsWorkspaceBridge = (): void => {
  useEffect(() => {
    const api = window.api.window
    if (!api?.onWorkspaceNavigation) return
    let returnFocus: HTMLElement | undefined
    let returnFocusId: string | undefined
    const removeVisibility = api.onSettingsOpened?.((state) => {
      if (state.visible) {
        returnFocus =
          document.activeElement instanceof HTMLElement ? document.activeElement : undefined
        returnFocusId = returnFocus?.dataset.settingsTrigger
      } else {
        // A native window cannot use Radix's same-document trigger restoration. Successful
        // workspace navigation intentionally skips this event so its destination keeps focus.
        const target = returnFocus?.isConnected
          ? returnFocus
          : returnFocusId
            ? document.querySelector<HTMLElement>(
                `[data-settings-trigger="${CSS.escape(returnFocusId)}"]`
              )
            : undefined
        target?.focus()
        returnFocus = undefined
        returnFocusId = undefined
      }
    })
    const removeContext = useNavigationStore.subscribe((state, previous) => {
      if (state.activeProjectId !== previous.activeProjectId)
        void api
          .updateSettingsContext?.({ activeProjectId: state.activeProjectId })
          .catch(console.warn)
    })
    const remove = api.onWorkspaceNavigation(({ method, args, navigationToken }) => {
      const navigation = useNavigationStore.getState()
      const afterNavigate = (): void => {
        void api.workspaceNavigated?.(navigationToken).catch(console.warn)
      }
      switch (method) {
        case 'openProject':
          navigation.openProject(args[0] as string, 'user', afterNavigate)
          break
        case 'openSessionById':
          navigation.openSessionById(args[0] as string, 'user', afterNavigate)
          break
        case 'openLiteratureItem':
          navigation.openLiteratureItem(
            args[0] as string,
            'user',
            args[2] as PdfAnnotation | undefined,
            afterNavigate
          )
          break
        case 'startCustomizeConversation':
          navigation.startCustomizeConversation(
            args[0] as string,
            args[1] as CustomizeGoal,
            afterNavigate
          )
          break
        case 'startWslSupportConversation':
          navigation.startWslSupportConversation(
            args[0] as string,
            args[1] as ComposerDoc,
            args[2] as string,
            afterNavigate
          )
          break
        case 'requestWslSetupProjectCreation':
          navigation.requestWslSetupProjectCreation(afterNavigate)
          break
      }
    })
    return () => {
      remove()
      removeContext()
      removeVisibility?.()
    }
  }, [])
}
