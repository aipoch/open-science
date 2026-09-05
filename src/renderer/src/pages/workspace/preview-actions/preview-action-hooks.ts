import { useContext, useEffect, type RefObject } from 'react'

import { useActionMenuTarget, type ActionMenuTargetController } from '@/components/action-menu'

import {
  PreviewActionMenuAdapterContext,
  type PreviewActionMenuAdapter
} from './preview-action-adapter-context'
import type { PreviewCapabilityId } from './preview-action-model'

export const usePreviewActions = (): ActionMenuTargetController<PreviewCapabilityId> &
  Pick<PreviewActionMenuAdapter, 'openContextMenu'> => {
  const adapter = useContext(PreviewActionMenuAdapterContext)
  const target = useActionMenuTarget<PreviewCapabilityId>()
  if (!adapter) {
    throw new Error('Preview actions must be used inside PreviewActionMenuAdapterProvider.')
  }
  return { ...target, openContextMenu: adapter.openContextMenu }
}

export const useRegisterPreviewContextMenuFrame = ({
  id,
  frameUrl,
  frameRef,
  enabled = true
}: {
  id: string
  frameUrl: string
  frameRef: RefObject<HTMLIFrameElement | null>
  enabled?: boolean
}): void => {
  const adapter = useContext(PreviewActionMenuAdapterContext)
  useEffect(() => {
    if (!adapter || !enabled || !frameUrl) return
    return adapter.registerFrame({ id, frameUrl, getFrame: () => frameRef.current })
  }, [adapter, enabled, frameRef, frameUrl, id])
}
