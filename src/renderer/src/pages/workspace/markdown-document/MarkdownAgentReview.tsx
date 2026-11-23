import { diffWordsWithSpace } from 'diff'
import { RangeApi, type TRange, type Value } from 'platejs'
import { useEditorRef, useEditorSelector } from 'platejs/react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { MarkdownAgentPrompt, type MarkdownAgentRequest } from './MarkdownAgentPrompt'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'

export type MarkdownReplacement = Readonly<{
  markdown: string
  token: string
  onDismiss: () => void
}>
type Capture = { range: TRange; value: Value; markdown: string; token: string }

export function MarkdownAgentReview({
  replacement,
  disabled,
  onSubmitRequest
}: {
  replacement?: MarkdownReplacement
  disabled: boolean
  onSubmitRequest?: (request: MarkdownAgentRequest) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const [capture, setCapture] = useState<Capture>()
  // Slate changes the children array on document operations, but not selection operations.
  const current = useEditorSelector((e) => !!capture && e.children === capture.value, [capture])
  const before = capture && replacement?.token === capture.token ? capture.markdown : undefined
  const after = replacement?.markdown
  const review = useMemo(() => {
    if (before === undefined || after === undefined) return undefined
    const parsed = parseMarkdownDocument(after)
    const changes = diffWordsWithSpace(before, after, { maxEditLength: 512 }) ?? [
      { value: before, removed: true, added: false },
      { value: after, added: true, removed: false }
    ]
    return { parsed, changes }
  }, [before, after])
  const dismiss = (): void => {
    // Dismissing an old response must not consume the newer request.
    if (capture?.token === replacement?.token) setCapture(undefined)
    replacement?.onDismiss()
  }
  return (
    <>
      <MarkdownAgentPrompt
        disabled={disabled}
        onSubmitRequest={
          onSubmitRequest &&
          (async (request, range) => {
            const next =
              range && !RangeApi.isCollapsed(range)
                ? {
                    range,
                    value: editor.children,
                    token: crypto.randomUUID(),
                    markdown: serializeMarkdownDocument(editor.api.fragment(range) as Value)
                  }
                : undefined
            setCapture(next)
            let accepted = false
            try {
              accepted = await onSubmitRequest(
                next
                  ? { ...request, selectionMarkdown: next.markdown, selectionToken: next.token }
                  : request
              )
              return accepted
            } finally {
              if (!accepted) setCapture((previous) => (previous === next ? undefined : previous))
            }
          })
        }
      />
      {replacement && (
        <section className="border-b border-border p-3" aria-label={t('Review replacement')}>
          <h3 className="text-sm font-semibold">{t('Review replacement')}</h3>
          {!review || !current ? (
            <ErrorNotice
              inline
              role="alert"
              title={t('The selected passage is no longer available.')}
            />
          ) : (
            <>
              <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
                {review.changes.map((part, i) =>
                  part.removed ? (
                    <del
                      key={i}
                      className="bg-status-failure-surface dark:bg-status-failure-dark-surface"
                    >
                      {part.value}
                    </del>
                  ) : part.added ? (
                    <ins
                      key={i}
                      className="bg-status-success-surface dark:bg-status-success-dark-surface"
                    >
                      {part.value}
                    </ins>
                  ) : (
                    part.value
                  )
                )}
              </pre>
              {review.parsed.mode !== 'rich' && (
                <ErrorNotice
                  inline
                  role="alert"
                  title={t('Markdown could not be converted safely.')}
                />
              )}
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={dismiss}>
              {t('Reject')}
            </Button>
            <Button
              size="sm"
              disabled={disabled || !current || review?.parsed.mode !== 'rich'}
              onClick={() => {
                if (
                  disabled ||
                  !capture ||
                  capture.value !== editor.children ||
                  capture.token !== replacement.token ||
                  review?.parsed.mode !== 'rich'
                )
                  return
                const fragment = review.parsed.value
                editor.tf.withNewBatch(() =>
                  editor.tf.withoutNormalizing(() => {
                    editor.tf.select(capture.range)
                    const [start, end] = RangeApi.edges(capture.range)
                    if (replacement.markdown === '') {
                      editor.tf.delete({ at: capture.range, hanging: true })
                    } else if (
                      editor.api.isStart(start, [start.path[0]]) &&
                      editor.api.isEnd(end, [end.path[0]])
                    ) {
                      // Fragment insertion merges boundary blocks like paste. A selection
                      // covering whole blocks must also replace their types (e.g. p → h2).
                      for (let i = end.path[0]; i >= start.path[0]; i--) {
                        editor.tf.removeNodes({ at: [i] })
                      }
                      editor.tf.insertNodes(fragment, { at: [start.path[0]], select: true })
                    } else {
                      editor.tf.insertFragment(fragment, { at: capture.range, hanging: true })
                    }
                  })
                )
                dismiss()
              }}
            >
              {t('Accept')}
            </Button>
          </div>
        </section>
      )}
    </>
  )
}
