import { Children, memo, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AgentMarkdown, type AgentMarkdownExtension } from '@/components/streamdown/AgentMarkdown'
import type { PreviewFileFormat } from '@/stores/preview-workbench-store'
import type {
  ManagedFileVersionDiffResult,
  ManagedFileVersionDiffSegment
} from '../../../../shared/managed-file-versions'

import { getFileExtension } from './preview-support'
import {
  toDiffPresentationBlocks,
  type DiffRenderBlock,
  type DiffPresentationKind,
  type MarkdownChangeTags
} from './managed-version-diff-presentation'

type ManagedVersionDiffContentProps = {
  result: ManagedFileVersionDiffResult
  format: PreviewFileFormat
  name: string
}

const markdownChangeStyles =
  '[&_[data-managed-diff=added]]:bg-diff-added-highlight [&_[data-managed-diff=added]]:font-medium [&_[data-managed-diff=added]]:text-text-000 [&_[data-managed-diff=added]]:no-underline [&_[data-managed-diff=removed]]:bg-diff-removed-highlight [&_[data-managed-diff=removed]]:text-text-000 [&_[data-managed-diff=removed]]:line-through'

type ManagedDiffTagProps = Record<string, unknown> & { children?: ReactNode }
type DiffSegment = ManagedFileVersionDiffSegment
type MarkdownDiffBlock = Extract<DiffRenderBlock, { kind: 'markdown' }>

const ManagedDiffAdded = ({ children }: ManagedDiffTagProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isMarker = Children.count(children) === 0
  return (
    <ins data-managed-diff="added" data-managed-diff-marker={isMarker ? 'added' : undefined}>
      <span className="sr-only">{t('Added:')} </span>
      {isMarker ? null : <span data-managed-diff-content="">{children}</span>}
    </ins>
  )
}

const ManagedDiffRemoved = ({ children }: ManagedDiffTagProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isMarker = Children.count(children) === 0
  return (
    <del data-managed-diff="removed" data-managed-diff-marker={isMarker ? 'removed' : undefined}>
      <span className="sr-only">{t('Removed:')} </span>
      {isMarker ? null : <span data-managed-diff-content="">{children}</span>}
    </del>
  )
}

const ControlCharacterLabel = ({ text }: { text: string }): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!/^[\r\n]+$/u.test(text)) return null
  const label =
    text === '\r'
      ? t('Carriage return (CR)')
      : text === '\n'
        ? t('Line feed (LF)')
        : text === '\r\n'
          ? t('Line ending (CRLF)')
          : t('Line ending characters')
  return (
    <span
      data-diff-format-label=""
      className="mx-1 select-none rounded border px-1 font-sans text-xs no-underline"
      style={{ textDecoration: 'none' }}
    >
      {label}
    </span>
  )
}

const DiffSegments = ({ segments }: { segments: DiffSegment[] }): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <>
      {segments.map((segment, segmentIndex) =>
        segment.kind === 'added' ? (
          <ins
            key={segmentIndex}
            data-diff-segment="added"
            data-managed-diff="added"
            className="bg-diff-added-highlight font-medium text-text-000 no-underline"
          >
            <span className="sr-only">{t('Added:')} </span>
            <ControlCharacterLabel text={segment.text} />
            <span data-managed-diff-content="">{segment.text}</span>
          </ins>
        ) : segment.kind === 'removed' ? (
          <del
            key={segmentIndex}
            data-diff-segment="removed"
            data-managed-diff="removed"
            className="bg-diff-removed-highlight text-text-000 line-through"
          >
            <span className="sr-only">{t('Removed:')} </span>
            <ControlCharacterLabel text={segment.text} />
            <span data-managed-diff-content="">{segment.text}</span>
          </del>
        ) : (
          <span key={segmentIndex}>{segment.text}</span>
        )
      )}
    </>
  )
}

const MarkdownDiffFallback = ({ block }: { block: MarkdownDiffBlock }): React.JSX.Element => (
  <pre
    data-managed-version-diff-fallback=""
    className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono"
  >
    {block.changeKind === 'mixed' ? (
      <DiffSegments segments={block.fallbackSegments} />
    ) : (
      block.content
    )}
  </pre>
)

const createMarkdownChangeTags = (): MarkdownChangeTags => {
  const randomValues = new Uint32Array(4)
  globalThis.crypto.getRandomValues(randomValues)
  const nonce = Array.from(randomValues, (value) => value.toString(36)).join('')
  return {
    added: `managed-diff-added-${nonce}`,
    removed: `managed-diff-removed-${nonce}`
  }
}

const resolveDiffPresentationKind = (
  format: PreviewFileFormat,
  name: string
): DiffPresentationKind => {
  if (format === 'markdown') return 'markdown'
  if (format === 'text' && getFileExtension(name) === 'txt') return 'prose'
  return 'structured'
}

const ManagedVersionDiffContent = memo(
  ({ result, format, name }: ManagedVersionDiffContentProps): React.JSX.Element => {
    const { t } = useTranslation()
    const presentationKind = resolveDiffPresentationKind(format, name)
    const [markdownChangeTags] = useState(createMarkdownChangeTags)
    const markdownExtension = useMemo<AgentMarkdownExtension>(
      () => ({
        allowedTags: {
          [markdownChangeTags.added]: [],
          [markdownChangeTags.removed]: []
        },
        components: {
          [markdownChangeTags.added]: ManagedDiffAdded,
          [markdownChangeTags.removed]: ManagedDiffRemoved
        }
      }),
      [markdownChangeTags]
    )
    const blocks = useMemo(
      () => toDiffPresentationBlocks(result, presentationKind, markdownChangeTags),
      [markdownChangeTags, presentationKind, result]
    )

    const lastBefore = result.lines.findLast(
      (line) => line.kind === 'context' || line.kind === 'removed'
    )
    const lastAfter = result.lines.findLast(
      (line) => line.kind === 'context' || line.kind === 'added'
    )
    const endsWithNewline = (line: typeof lastBefore): boolean =>
      line !== undefined &&
      line.kind !== 'omitted' &&
      /\n$/u.test(line.segments.map((segment) => segment.text).join(''))
    const trailingNewlineChanged = endsWithNewline(lastBefore) !== endsWithNewline(lastAfter)

    return (
      <div
        className="min-h-full bg-bg-000 py-2 font-mono text-xs text-text-000"
        role="region"
        aria-label={t('File version differences')}
      >
        {trailingNewlineChanged ? (
          <p className="mx-4 mb-2 select-none font-sans text-sm" data-diff-format-summary="">
            {endsWithNewline(lastAfter)
              ? t('Newline at end of file added')
              : t('Newline at end of file removed')}
          </p>
        ) : null}
        {result.baseFormat &&
        result.selectedFormat &&
        result.baseFormat.hasUtf8Bom !== result.selectedFormat.hasUtf8Bom ? (
          <p className="mx-4 mb-2 select-none font-sans text-sm" data-diff-format-summary="">
            {result.selectedFormat.hasUtf8Bom ? t('UTF-8 BOM added') : t('UTF-8 BOM removed')}
          </p>
        ) : null}
        {!result.lines.some((line) => line.kind === 'added' || line.kind === 'removed') ? (
          <p className="mx-4 mb-2 select-none font-sans text-sm">{t('No text changes.')}</p>
        ) : null}
        {result.lines.some((line) => line.kind === 'omitted') ? (
          <p className="mx-4 mb-2 select-none font-sans text-xs text-text-100">
            {t(
              'Unchanged sections are omitted. Use the version preview or download to read the complete files.'
            )}
          </p>
        ) : null}
        {blocks.map((block) => {
          if (block.kind === 'omitted') {
            const lineCount = block.count
            return (
              <div
                key={`omitted:${block.startIndex}`}
                data-diff-kind="omitted"
                className="my-2 select-none border-y px-4 py-2 font-sans text-text-100"
              >
                {t(
                  'Unchanged lines omitted: {{lineCount}} (base {{oldStart}}–{{oldEnd}}, selected {{newStart}}–{{newEnd}})',
                  {
                    lineCount,
                    oldStart: block.oldLineNumber,
                    oldEnd: block.oldLineNumber + lineCount - 1,
                    newStart: block.newLineNumber,
                    newEnd: block.newLineNumber + lineCount - 1
                  }
                )}
              </div>
            )
          }
          if (block.kind === 'markdown') {
            if (block.changeKind === 'context' || block.changeKind === 'mixed') {
              return (
                <div
                  key={`markdown:${block.startIndex}`}
                  className={`managed-version-diff-markdown min-w-0 px-4 font-sans ${block.changeKind === 'mixed' ? markdownChangeStyles : ''}`}
                  data-diff-kind={block.changeKind}
                >
                  <AgentMarkdown
                    content={block.content}
                    allowMedia={false}
                    extension={markdownExtension}
                    fallback={<MarkdownDiffFallback block={block} />}
                  />
                </div>
              )
            }
            return block.changeKind === 'added' ? (
              <ins
                key={`markdown:${block.startIndex}:added`}
                className="block min-w-0 px-4 font-sans font-medium text-diff-added-foreground no-underline"
                data-diff-kind="added"
                data-managed-diff="added"
              >
                <span className="sr-only">{t('Added content:')} </span>
                <AgentMarkdown
                  content={block.content}
                  allowMedia={false}
                  extension={markdownExtension}
                  fallback={<MarkdownDiffFallback block={block} />}
                />
              </ins>
            ) : (
              <del
                key={`markdown:${block.startIndex}:removed`}
                className="block min-w-0 px-4 font-sans text-diff-removed-foreground line-through"
                data-diff-kind="removed"
                data-managed-diff="removed"
              >
                <span className="sr-only">{t('Removed content:')} </span>
                <AgentMarkdown
                  content={block.content}
                  allowMedia={false}
                  extension={markdownExtension}
                  fallback={<MarkdownDiffFallback block={block} />}
                />
              </del>
            )
          }
          return (
            <div
              key={`text:${block.startIndex}`}
              className="min-h-6 px-4"
              data-diff-kind={block.changeKind}
            >
              <pre className="min-w-0 whitespace-pre-wrap break-words font-mono">
                <DiffSegments segments={block.segments} />
              </pre>
            </div>
          )
        })}
      </div>
    )
  }
)

ManagedVersionDiffContent.displayName = 'ManagedVersionDiffContent'

export { ManagedVersionDiffContent }
