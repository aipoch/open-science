import { FileText, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import type { SkillImportPreviewContent } from '../../../../shared/settings'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'

type SkillImportCandidatePreviewProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  error: string | null
  content: SkillImportPreviewContent | null
}

const metadataLabel = (key: string): string =>
  key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

// One read-only preview module shared by every pre-import source. Callers adapt candidate identity
// into SkillImportPreviewContent; loading, error isolation, accessibility, and presentation stay here.
const SkillImportCandidatePreview = ({
  open,
  onOpenChange,
  loading,
  error,
  content
}: SkillImportCandidatePreviewProps): React.JSX.Element => {
  const metadata = content ? Object.entries(content.metadata) : []

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[min(88vh,760px)] w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileText className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <Dialog.Title className="truncate text-base font-semibold text-foreground">
                  {content?.name ?? 'Skill preview'}
                </Dialog.Title>
              </div>
              <Dialog.Description className="mt-1 break-all text-xs text-muted-foreground">
                {content?.sourceLabel ?? 'Loading candidate content…'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close preview"
                className={dialogCloseButtonClassName}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <div
                className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                Loading preview…
              </div>
            ) : error ? (
              <div
                className="rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-sm text-danger-000"
                role="alert"
              >
                {error}
              </div>
            ) : content ? (
              <>
                {content.description ? (
                  <p className="text-sm leading-6 text-muted-foreground [text-wrap:pretty]">
                    {content.description}
                  </p>
                ) : null}

                <section className="mt-5 border-t border-border pt-4">
                  <h2 className="mb-3 text-sm font-semibold text-foreground">SKILL.md</h2>
                  <AgentMarkdown content={content.body} allowMedia={false} />
                </section>

                {metadata.length > 0 ? (
                  <section className="mt-5 border-t border-border pt-4">
                    <h2 className="mb-2 text-sm font-semibold text-foreground">Metadata</h2>
                    <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                      {metadata.map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <dt className="text-xs font-medium text-muted-foreground">
                            {metadataLabel(key)}
                          </dt>
                          <dd className="break-words text-sm text-foreground">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ) : null}

                {content.files.length > 0 ? (
                  <section className="mt-5 border-t border-border pt-4">
                    <h2 className="mb-2 text-sm font-semibold text-foreground">Files</h2>
                    <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                      {content.files.map((file) => (
                        <li key={file} className="break-all rounded bg-muted/50 px-2 py-1">
                          {file}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { SkillImportCandidatePreview }
