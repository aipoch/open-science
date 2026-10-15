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
  return createElement(
    Suspense,
    { fallback: null },
    createElement(FilePreviewDialog, {
      ...props,
      onReadWithAgent: props.onReadWithAgent
        ? (item) => {
            if (item.format === 'pdf') props.onReadWithAgent?.({ ...item, format: 'pdf' })
          }
        : undefined
    })
  )
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
  useProjectFormDialog(options) {
    const form = useProjectFormDialog(options)
    return {
      openCreateDialog: form.openCreateDialog,
      isOpen: form.dialogProps.open,
      dialog: createElement(ProjectFormDialog, form.dialogProps)
    }
  },
  FilePreviewDialog: memo(LiteratureFilePreview),
  createBookmarkPreviewItem(target) {
    const item = createBookmarkPreviewItem(target)
    return item?.format === 'pdf' ? { ...item, format: 'pdf' } : undefined
  },
  requestPdfAnnotationReveal: (...args) => requestPdfAnnotationReveal(...args),
  resolvePdfContextTarget,
  async loadPdf(input) {
    return 'resource' in input
      ? (
          await import('@/pages/workspace/previews/managed-pdf-document')
        ).createManagedPdfLoadingTask(input.resource)
      : (await import('@/pages/workspace/previews/pdfjs')).pdfjsLib.getDocument({
          data: input.data
        })
  }
}
