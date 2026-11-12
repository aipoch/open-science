import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useResearchFilmNoticeStore,
  isResearchFilmVisible
} from '@/stores/research-film-notice-store'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { ResearchVideoButton } from './research-video-button'
import { ErrorNotice } from './error-notice'
import { WorkflowDialogFrame } from './ui/workflow-dialog-frame'
import { runNotificationTask } from './notification-safety'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

export function ResearchFilmNotificationHost(): React.JSX.Element | null {
  const { t } = useTranslation()
  const web = document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'
  const target = useResearchFilmNoticeStore((state) => state.target)
  const visible = useResearchFilmNoticeStore((state) => state.visible)
  const items = useNotificationInboxStore((state) => state.items)
  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const navigation = useNavigationStore()
  const [readyToken, setReadyToken] = useState<number>()
  const [errorToken, setErrorToken] = useState<number>()
  const close = (): void => useResearchFilmNoticeStore.setState({ target: undefined })

  useEffect(() => {
    const acknowledge = (): void => {
      if (!document.hasFocus()) return
      const ids = items
        .filter(
          (item) =>
            item.source === 'research-film' &&
            item.readAt === undefined &&
            isResearchFilmVisible(item)
        )
        .map((item) => item.id)
      if (ids.length) runNotificationTask(() => useNotificationInboxStore.getState().markRead(ids))
    }
    acknowledge()
    window.addEventListener('focus', acknowledge)
    return () => window.removeEventListener('focus', acknowledge)
  }, [items, visible])

  useEffect(() => {
    if (!target || web) return
    if (
      navigation.view !== 'workspace' ||
      navigation.activeProjectId !== target.projectId ||
      selectedSessionId !== target.sessionId ||
      navigation.userNavigationRevision !== target.navigationRevision
    ) {
      useResearchFilmNoticeStore.setState({ target: undefined })
      return
    }
    if (readyToken === target.token || errorToken === target.token) return
    const session = sessions.find(
      (entry) => entry.id === target.sessionId && entry.projectId === target.projectId
    )
    if (session?.contentLoaded === false) return
    if (
      !session ||
      session.archivedAt ||
      (target.branchId &&
        !session.conversationGraph?.branches.some((branch) => branch.id === target.branchId))
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Resolve the external session-store navigation once hydration or activation settles.
      setErrorToken(target.token)
      return
    }
    const branch = session.conversationGraph?.branches.find((entry) => entry.id === target.branchId)
    if (
      target.branchId &&
      session.conversationGraph?.frames.find((frame) => frame.id === branch?.agentFrameId)
        ?.activeBranchId !== target.branchId
    ) {
      useSessionStore.getState().activateMessageBranch(target.sessionId, target.branchId)
      const graph = useSessionStore
        .getState()
        .sessions.find((entry) => entry.id === target.sessionId)?.conversationGraph
      if (
        !graph?.frames.some(
          (frame) => frame.id === branch?.agentFrameId && frame.activeBranchId === target.branchId
        )
      ) {
        setErrorToken(target.token)
        return
      }
    }
    setReadyToken(target.token)
  }, [
    target,
    readyToken,
    errorToken,
    sessions,
    selectedSessionId,
    navigation.view,
    navigation.activeProjectId,
    navigation.userNavigationRevision,
    web
  ])

  if (!target) return null
  if (web || errorToken === target.token)
    return (
      <WorkflowDialogFrame busy={false} onClose={close} footer={null} title={t('Research film')}>
        <ErrorNotice
          title={
            web
              ? t('Research films can only be opened in the desktop app.')
              : t('Could not open the research film branch.')
          }
          description={
            web
              ? undefined
              : t('The branch may be unavailable or busy. Open the conversation and try again.')
          }
        />
      </WorkflowDialogFrame>
    )
  if (readyToken !== target.token) return null
  return (
    <ResearchVideoButton
      key={target.token}
      projectId={target.projectId}
      sessionId={target.sessionId}
      branchId={target.branchId}
      initiallyOpen
      onClosed={close}
      renderTrigger={() => null}
    />
  )
}
