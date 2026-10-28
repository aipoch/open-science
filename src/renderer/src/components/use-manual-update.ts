import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateInstaller, UpdateStatus } from '../../../shared/update'
import { useUpdateStore } from '@/stores/update-store'

export type ManualUpdateController = {
  guideOpen: boolean
  guideOpenRef: RefObject<boolean>
  originId: string
  installer: UpdateInstaller | null
  feedback: string | undefined
  openGuide: (event: MouseEvent<HTMLElement>) => void
  closeGuide: () => void
  reveal: () => Promise<void>
}

const installerIdentity = (status: UpdateStatus): string =>
  JSON.stringify([status.latest, status.download, status.artifactSha512, status.localPath])
const currentInstallerIdentity = (): string => installerIdentity(useUpdateStore.getState().status)

// Inspect only the updater's confirmed artifact. Reading instructions and revealing a package never
// invoke download, install, save, or lifecycle commands, including during restricted recovery.
export const useManualUpdate = (open: boolean): ManualUpdateController => {
  const { t } = useTranslation()
  const status = useUpdateStore((state) => state.status)
  const originId = useId()
  const [view, setView] = useState({ open, guideOpen: false })
  // A new opening starts on the update view. Reset from the controlled open value during render,
  // so no post-commit effect can briefly reopen the previous instructions page.
  if (view.open !== open) setView({ open, guideOpen: false })
  const guideOpen = open && view.open === open && view.guideOpen
  const guideOpenRef = useRef(false)
  const [inspected, setInspected] = useState<{ key: string; installer: UpdateInstaller | null }>()
  const [feedback, setFeedback] = useState<{ key: string; text: string }>()
  const origin = useRef<HTMLElement | null>(null)
  const originKey = useRef<string | null>(null)
  const returning = useRef(false)
  const revision = useRef(0)
  const revealing = useRef(false)
  const artifactKey = installerIdentity(status)

  useLayoutEffect(() => {
    if (!open) guideOpenRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    const inspect = (): void => {
      const request = ++revision.current
      void window.api?.update
        ?.getInstaller?.()
        .then((result) => {
          if (revision.current !== request || artifactKey !== currentInstallerIdentity()) return
          setInspected({ key: artifactKey, installer: result })
          setFeedback(undefined)
        })
        .catch(() => {
          if (revision.current !== request || artifactKey !== currentInstallerIdentity()) return
          setInspected({ key: artifactKey, installer: null })
        })
    }
    inspect()
    window.addEventListener('focus', inspect)
    return () => {
      revision.current += 1
      window.removeEventListener('focus', inspect)
    }
  }, [open, artifactKey])

  useLayoutEffect(() => {
    if (guideOpen || !returning.current) return
    returning.current = false
    const entries = [...document.querySelectorAll<HTMLElement>('[data-manual-update-origin]')]
    const target = origin.current?.isConnected
      ? origin.current
      : (entries.find((element) => element.dataset.manualUpdateOrigin === originKey.current) ??
        entries.find((element) => element.dataset.manualUpdateOrigin === `${originId}-links`))
    target?.focus()
  }, [guideOpen, originId])

  return {
    guideOpen,
    guideOpenRef,
    originId,
    installer: inspected?.key === artifactKey ? inspected.installer : null,
    feedback: status.installerMissing
      ? t('The installer is missing or has changed. Download the update again.')
      : feedback?.key === artifactKey
        ? feedback.text
        : undefined,
    openGuide: (event): void => {
      origin.current = event.currentTarget
      originKey.current = event.currentTarget.dataset.manualUpdateOrigin ?? null
      guideOpenRef.current = true
      setView({ open, guideOpen: true })
    },
    closeGuide: (): void => {
      returning.current = true
      guideOpenRef.current = false
      setView({ open, guideOpen: false })
    },
    reveal: async (): Promise<void> => {
      if (revealing.current) return
      revealing.current = true
      const target = currentInstallerIdentity()
      try {
        const result = await window.api?.update?.revealInstaller?.()
        if (target !== currentInstallerIdentity()) return
        if (result === 'missing') {
          setInspected({ key: target, installer: null })
          setFeedback({
            key: target,
            text: t('The installer is missing or has changed. Download the update again.')
          })
        } else if (result !== 'revealed') {
          setInspected({ key: target, installer: null })
          setFeedback({
            key: target,
            text: t('The installer is unavailable. Download it from the website.')
          })
        }
      } catch {
        if (target === currentInstallerIdentity())
          setFeedback({ key: target, text: t('Could not show the installer. Try again.') })
      } finally {
        revealing.current = false
      }
    }
  }
}
