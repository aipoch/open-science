import { create } from 'zustand'
import type { ResearchVideoPresentationRequest } from '../../../shared/research-video-presentation'
import { useNavigationStore } from './navigation-store'

type FilmNoticeState = {
  target?: ResearchVideoPresentationRequest & { token: number; navigationRevision: number }
  visible: Record<string, ResearchVideoPresentationRequest>
}

export const useResearchFilmNoticeStore = create<FilmNoticeState>(() => ({ visible: {} }))
let nextToken = 0

export const sameResearchFilm = (
  left: Partial<ResearchVideoPresentationRequest>,
  right: Partial<ResearchVideoPresentationRequest>
): boolean =>
  left.projectId === right.projectId &&
  left.sessionId === right.sessionId &&
  left.branchId === right.branchId

export const isResearchFilmVisible = (target: Partial<ResearchVideoPresentationRequest>): boolean =>
  Object.values(useResearchFilmNoticeStore.getState().visible).some((visible) =>
    sameResearchFilm(visible, target)
  )

// The navigation callback runs only after the preview leave guard accepts the transition.
export const openResearchFilmNotification = (
  request: ResearchVideoPresentationRequest,
  afterNavigate?: () => void
): boolean =>
  useNavigationStore.getState().openSessionById(request.sessionId, 'notification', () => {
    useResearchFilmNoticeStore.setState({
      target: {
        ...request,
        token: ++nextToken,
        navigationRevision: useNavigationStore.getState().userNavigationRevision
      }
    })
    afterNavigate?.()
  })
