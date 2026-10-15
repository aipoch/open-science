import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'
import { createElement, lazy, memo, Suspense, type ComponentProps, type ReactElement } from 'react'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { ProjectFormDialog } from '@/pages/home/ProjectFormDialog'
import {
  createBookmarkPreviewItem,
  requestPdfAnnotationReveal
} from '@/pages/workspace/annotations/annotation-reveal'
import { resolvePdfContextTarget } from '@/pages/workspace/use-pdf-context-action'
import type { LiteratureRendererHost } from '@/pages/literature/public/host'

const FilePreviewDialog = lazy(() =>
  import('@/pages/workspace/FilePreviewDialog').then((module) => ({
    default: module.FilePreviewDialog
  }))
)

function LiteratureFilePreview(
  props: ComponentProps<LiteratureRendererHost['FilePreviewDialog']>
): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(FilePreviewDialog, props))
}

export const literatureRendererHost: LiteratureRendererHost = {
  get api() {
    return window.api
  },
  onRecovered: (listener) =>
    useDesktopRuntimeRecoveryStore.subscribe((state, previous) => {
      if (state.phase === 'connected' && previous.phase !== 'connected') listener()
    }),
  useNavigationStore,
  useProjectStore,
  useTagStore,
  useSettingsStore,
  useProjectFormDialog,
  FilePreviewDialog: memo(LiteratureFilePreview),
  ProjectFormDialog,
  createBookmarkPreviewItem,
  requestPdfAnnotationReveal: (...args) => requestPdfAnnotationReveal(...args),
  resolvePdfContextTarget
}
