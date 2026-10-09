import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'
import type { ReplayResource } from '../../../../../shared/replay'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../../shared/uploads'
import { createPreviewFileItem } from '../preview-file-item'
import { PreviewFileContent } from '../previews/PreviewFileContent'
import { PreviewActionMenuAdapterProvider } from '../preview-actions/preview-action-adapter'
import {
  PREVIEW_CAPABILITY_CATALOG,
  shouldHandlePreviewContextMenu,
  type PreviewCapabilityId
} from '../preview-actions/preview-action-model'
import { RecordedResourcePreview } from './results/RecordedResourcePreview'
import { readRecordedResource } from './results/recorded-resource-reader'

// Replay's HTML and simple files use the same inert byte renderer as the browser viewer.
// Rich document readers remain read-only, without annotation or latest-version navigation.
export default function ReplayFilePreview({
  resource,
  onClose
}: {
  resource: ReplayResource
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const targetId = useId()
  const item = useMemo(() => {
    const source = resource.source ?? 'artifact'
    const fileId = source === 'upload' ? resource.fileId : resource.artifactId
    if (
      !fileId ||
      !resource.versionId ||
      !resource.sessionId ||
      !resource.projectId ||
      resource.availability !== 'recorded'
    )
      return undefined
    return createPreviewFileItem({
      id: `replay:${resource.id}`,
      projectId: resource.projectId,
      sessionId: resource.sessionId,
      path:
        source === 'upload'
          ? createUploadVersionReference(resource.versionId, {
              projectId: resource.projectId,
              sessionId: resource.sessionId,
              fileId
            })
          : createArtifactVersionLocator({
              projectId: resource.projectId,
              appSessionId: resource.sessionId,
              artifactId: fileId,
              versionId: resource.versionId
            }),
      name: resource.name,
      mimeType: resource.mimeType,
      source,
      managedFileId: fileId,
      artifactId: source === 'artifact' ? fileId : undefined,
      selectedVersionId: resource.versionId,
      versionNumber: resource.versionNumber,
      size: resource.size
    })
  }, [resource])
  if (!item)
    return <p className="p-4 text-sm text-text-300">{t('The recorded evidence is unavailable.')}</p>
  return (
    <ActionMenuProvider testId="replay-preview-context-menu">
      <PreviewActionMenuAdapterProvider targetId={targetId}>
        <ActionMenuTarget<PreviewCapabilityId, undefined>
          targetId={targetId}
          identityKey={JSON.stringify([
            item.projectId,
            item.source,
            item.managedFileId,
            item.selectedVersionId
          ])}
          catalog={PREVIEW_CAPABILITY_CATALOG}
          recipe={[{ kind: 'action', action: 'close' }]}
          bindings={{ close: { execute: onClose } }}
          invocation={undefined}
          resolveInvocation={(event) =>
            shouldHandlePreviewContextMenu(event.target) ? undefined : null
          }
          asChild
        >
          <div
            className="relative size-full min-h-0 overflow-hidden"
            data-replay-file-preview={resource.id}
          >
            {resource.mimeType?.startsWith('text/') ||
            resource.mimeType?.startsWith('image/') ||
            /\.(?:html?|json|csv|tsv|md|txt|xml|log|svg|png|jpe?g|webp)$/i.test(resource.name) ? (
              <RecordedResourcePreview resource={resource} read={readRecordedResource} />
            ) : (
              <PreviewFileContent item={item} readOnly />
            )}
          </div>
        </ActionMenuTarget>
      </PreviewActionMenuAdapterProvider>
    </ActionMenuProvider>
  )
}
