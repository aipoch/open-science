import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import type { SkillMarketplaceUpdatePreview } from '../../../../shared/skill-marketplace'
import { SkillReplacementSummary } from './SkillImportCandidatePreview'

export function SkillMarketplaceUpdateDialog({
  preview,
  version,
  pending,
  error,
  onCancel,
  onConfirm
}: {
  preview: SkillMarketplaceUpdatePreview | undefined
  version: string
  pending: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={Boolean(preview)}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[88vh] w-[min(800px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className="border-b border-border px-5 py-4">
            <Dialog.Title className="text-base font-semibold">
              {t('Review Skill update')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {t(
                'Update the existing Skill in place. Its identity and Specialist relationships will be preserved.'
              )}
            </Dialog.Description>
          </div>
          {preview ? (
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <p className="font-medium">{preview.displayName}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Update Skill from {{from}} to {{to}}?', {
                  from: preview.installedVersion ?? t('Unknown'),
                  to: version
                })}
              </p>
              <p className="mt-3 text-sm">
                {t('Affected Specialists')}:{' '}
                {preview.specialists.length
                  ? preview.specialists.map((item) => item.name).join(', ')
                  : t('None')}
              </p>
              {preview.mainEnabled ? (
                <p className="mt-1 text-sm">
                  {t('This Skill is also enabled for the Main Agent.')}
                </p>
              ) : null}
              <p className="mt-3 text-sm text-muted-foreground">
                {preview.localChanges === 'unknown'
                  ? t(
                      'The original installed content is unavailable. Local changes cannot be determined.'
                    )
                  : preview.localChanges === 'modified'
                    ? t('This Skill has local changes. Updating will replace them.')
                    : t('The installed files match the previous Marketplace release.')}
              </p>
              <SkillReplacementSummary
                replacement={{
                  targetId: preview.localSkillId,
                  sourceLabel: preview.source === 'personal' ? t('Personal') : t('Imported'),
                  added: preview.added,
                  modified: preview.modified,
                  removed: preview.removed
                }}
              />
              {preview.differences.map((file) => (
                <details key={file.path} className="mt-2 rounded-md border border-border p-3">
                  <summary className="cursor-pointer break-all font-mono text-xs">
                    {file.path}
                  </summary>
                  {file.patch ? (
                    <pre className="mt-3 overflow-x-auto whitespace-pre text-xs">{file.patch}</pre>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t(
                        'Text comparison is unavailable for this file. It will be replaced or removed as listed above.'
                      )}
                    </p>
                  )}
                </details>
              ))}
              {error ? (
                <div className="mt-3">
                  <ErrorNotice tone="amber" title={error} role="alert" />
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button variant="outline" disabled={pending} onClick={onCancel}>
              {t('Cancel', { ns: 'common' })}
            </Button>
            <Button disabled={pending || Boolean(error)} onClick={onConfirm}>
              {pending ? t('Installing…') : t('Update existing Skill')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
