import { Children, memo, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AgentMarkdown, type AgentMarkdownExtension } from '@/components/streamdown/AgentMarkdown'
import type { PreviewFileFormat } from '@/stores/preview-workbench-store'
import type { ManagedFileVersionDiffResult } from '../../../../shared/managed-file-versions'

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
type DiffSegment = ManagedFileVersionDiffResult['lines'][number]['segments'][number]
type MarkdownDiffBlock = Extract<DiffRenderBlock, { kind: 'markdown' }>

const appendDiffSegment = (segments: DiffSegment[], segment: DiffSegment): void => {
  if (segment.text.length === 0) return
  const previous = segments.at(-1)
  if (previous?.kind === segment.kind) previous.text += segment.text
  else segments.push({ ...segment })
}

const decodeGeneratedMarkdownText = (content: string): string =>
  content.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

const markdownFallbackSegments = (content: string, tags: MarkdownChangeTags): DiffSegment[] => {
  const descriptors = (['added', 'removed'] as const).map((kind) => ({
    kind,
    opening: `<${tags[kind]}>`,
    closing: `</${tags[kind]}>`
  }))
  const segments: DiffSegment[] = []
  let cursor = 0

  while (cursor < content.length) {
    const next = descriptors
      .map((descriptor) => ({ descriptor, index: content.indexOf(descriptor.opening, cursor) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index)[0]
    if (!next) {
      appendDiffSegment(segments, { kind: 'context', text: content.slice(cursor) })
      break
    }

    appendDiffSegment(segments, {
      kind: 'context',
      text: content.slice(cursor, next.index)
    })
    const changedStart = next.index + next.descriptor.opening.length
    const changedEnd = content.indexOf(next.descriptor.closing, changedStart)
    if (changedEnd < 0) {
      appendDiffSegment(segments, { kind: 'context', text: content.slice(next.index) })
      break
    }

    const changedContent = content.slice(changedStart, changedEnd)
    cursor = changedEnd + next.descriptor.closing.length
    if (changedContent.length > 0) {
      appendDiffSegment(segments, {
        kind: next.descriptor.kind,
        text: decodeGeneratedMarkdownText(changedContent)
      })
      continue
    }

    // Empty markers represent a fully changed complex list item or table cell. In the raw fallback,
    // the exact source boundary is the rest of that item line or the current table cell.
    const lineStart = content.lastIndexOf('\n', next.index) + 1
    const lineEnd = content.indexOf('\n', cursor)
    const cellEnd = content.slice(lineStart, next.index).includes('|')
      ? content.indexOf('|', cursor)
      : -1
    const changedBoundary = [lineEnd, cellEnd]
      .filter((boundary) => boundary >= 0)
      .sort((left, right) => left - right)[0]
    const sourceEnd = changedBoundary ?? content.length
    appendDiffSegment(segments, {
      kind: next.descriptor.kind,
      text: content.slice(cursor, sourceEnd)
    })
    cursor = sourceEnd
  }

  return segments
}

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
            <span data-managed-diff-content="">{segment.text}</span>
          </del>
        ) : (
          <span key={segmentIndex}>{segment.text}</span>
        )
      )}
    </>
  )
}

const MarkdownDiffFallback = ({
  block,
  tags
}: {
  block: MarkdownDiffBlock
  tags: MarkdownChangeTags
}): React.JSX.Element => (
  <pre
    data-managed-version-diff-fallback=""
    className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono"
  >
    {block.changeKind === 'mixed' ? (
      <DiffSegments
        segments={block.fallbackSegments ?? markdownFallbackSegments(block.content, tags)}
      />
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

    return (
      <div
        className="min-h-full bg-bg-000 py-2 font-mono text-xs text-text-000"
        role="region"
        aria-label={t('File version differences')}
      >
        {blocks.map((block) => {
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
                    fallback={<MarkdownDiffFallback block={block} tags={markdownChangeTags} />}
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
                  fallback={<MarkdownDiffFallback block={block} tags={markdownChangeTags} />}
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
                  fallback={<MarkdownDiffFallback block={block} tags={markdownChangeTags} />}
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
