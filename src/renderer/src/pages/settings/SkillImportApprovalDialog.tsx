import { useState } from 'react'
import { PackagePlus } from 'lucide-react'
import { Dialog } from 'radix-ui'

import type {
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse,
  ConversationSkillImportSelection
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useSkillImportStore } from '@/stores/skill-import-store'
import { SkillImportCandidatePreview } from './SkillImportCandidatePreview'
import { useSkillImportCandidatePreview } from './useSkillImportCandidatePreview'

type SkillImportApprovalRequestDialogProps = {
  request: ConversationSkillImportApprovalRequest
  respond: (response: ConversationSkillImportApprovalResponse) => Promise<void>
}

const SkillImportApprovalRequestDialog = ({
  request,
  respond
}: SkillImportApprovalRequestDialogProps): React.JSX.Element => {
  const [selected, setSelected] = useState<Set<string>>(() =>
    request.previews.length === 1 ? new Set([request.previews[0].subPath]) : new Set()
  )
  const candidatePreview = useSkillImportCandidatePreview()

  const toggle = (subPath: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(subPath)) next.delete(subPath)
      else next.add(subPath)
      return next
    })
  }
  const allSelected = request.previews.length > 0 && selected.size === request.previews.length
  const toggleAll = (): void =>
    setSelected(() =>
      allSelected ? new Set() : new Set(request.previews.map((candidate) => candidate.subPath))
    )
  const invertSelection = (): void =>
    setSelected((current) => {
      const next = new Set<string>()
      for (const candidate of request.previews) {
        if (!current.has(candidate.subPath)) next.add(candidate.subPath)
      }
      return next
    })
  const confirm = (): void => {
    const items: ConversationSkillImportSelection[] = request.previews
      .filter((candidate) => selected.has(candidate.subPath))
      .map((candidate) => ({
        subPath: candidate.subPath,
        ...(candidate.replaceableId ? { replaceId: candidate.replaceableId } : {})
      }))
    void respond({ id: request.id, items })
  }
  const count = selected.size
  const importLabel =
    count > 0 ? `Import ${count} Skill${count === 1 ? '' : 's'}` : 'Import selected'

  return (
    <>
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => event.preventDefault()}
            className={dialogPanelClassName(
              'flex max-h-[min(88vh,760px)] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
            )}
          >
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <PackagePlus className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold text-foreground">
                  Import Skill package?
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">
                  The agent requested an import from{' '}
                  <span className="break-all font-medium text-foreground">
                    {request.attachmentName}
                  </span>
                  . Review and choose exactly what Open Science may install.
                </Dialog.Description>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Found {request.previews.length} skill{request.previews.length === 1 ? '' : 's'}
                </h3>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="size-4 shrink-0"
                  />
                  Select all
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={invertSelection}>
                  Invert
                </Button>
              </div>

              <ul className="mt-2 flex flex-col divide-y divide-border">
                {request.previews.map((candidate) => (
                  <li key={candidate.subPath} className="flex items-center gap-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${candidate.name}`}
                      checked={selected.has(candidate.subPath)}
                      onChange={() => toggle(candidate.subPath)}
                      className="size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {candidate.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {candidate.description || candidate.subPath}
                      </div>
                    </div>
                    {candidate.alreadyImported ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Already imported
                      </span>
                    ) : candidate.replaceableId ? (
                      <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                        Updates existing
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        candidatePreview.openPreview(() => {
                          if (candidate.previewError) throw new Error(candidate.previewError)
                          return {
                            name: candidate.name,
                            description: candidate.description,
                            sourceLabel: `${request.attachmentName} · ${candidate.subPath}`,
                            metadata: candidate.metadata,
                            body: candidate.body,
                            files: candidate.files
                          }
                        })
                      }
                    >
                      Preview
                    </Button>
                  </li>
                ))}
              </ul>

              {request.skipped.length > 0 ? (
                <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">Not importable</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {request.skipped.map((item) => (
                      <li key={`${item.source}:${item.reason}`}>
                        {item.source}: {item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => void respond({ id: request.id, cancelled: true })}
              >
                Cancel
              </Button>
              <Button type="button" disabled={count === 0} onClick={confirm}>
                {importLabel}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <SkillImportCandidatePreview {...candidatePreview.previewProps} />
    </>
  )
}

export function SkillImportApprovalDialog(): React.JSX.Element | null {
  const request = useSkillImportStore((state) => state.pending[0])
  const respond = useSkillImportStore((state) => state.respond)

  return request ? (
    <SkillImportApprovalRequestDialog key={request.id} request={request} respond={respond} />
  ) : null
}
