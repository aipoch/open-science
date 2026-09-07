import {
  Children,
  isValidElement,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
  type ReactNode
} from 'react'
import type { Components, ExtraProps } from 'streamdown'

import { cn } from '@/lib/utils'

type StreamingBlockquoteProps = ComponentProps<'blockquote'> & ExtraProps

// Streamdown's default blockquote chrome (its component is not exported); reproduced so the
// streaming override below is visually identical to the blockquote used once streaming settles.
const DEFAULT_BLOCKQUOTE_CLASS =
  'my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic'

const elementNodeTagName = (element: ReactElement): string | undefined =>
  (element.props as ExtraProps).node?.tagName

// Streamdown's MarkdownParagraph unwraps a lone image or fenced-code child, so no <p> reaches the
// DOM; the old `blockquote:not(:has(p:not(:empty)))` rule saw no paragraph in that case either.
const unwrapsToNonParagraph = (paragraph: ReactElement): boolean => {
  const children = Children.toArray((paragraph.props as { children?: ReactNode }).children).filter(
    (child) => child !== ''
  )
  if (children.length !== 1) return false
  const only = children[0]
  if (!isValidElement(only)) return false
  const tagName = elementNodeTagName(only)
  const onlyProps = only.props as Record<string, unknown>
  return tagName === 'img' || (tagName === 'code' && 'data-block' in onlyProps)
}

const paragraphIsVisible = (paragraph: ReactElement, customParagraph: Components['p']): boolean => {
  if (
    paragraph.type !== 'p' &&
    paragraph.type !== customParagraph &&
    unwrapsToNonParagraph(paragraph)
  ) {
    return false
  }
  return Children.toArray((paragraph.props as { children?: ReactNode }).children).some((child) =>
    typeof child === 'string' ? child.trim().length > 0 : true
  )
}

// Rendered-children equivalent of `blockquote:not(:has(p:not(:empty)))`: true when the quote has
// no descendant <p> with content (an unclosed trailing `>` renders an empty quote while streaming).
const hasVisibleParagraph = (node: ReactNode, customParagraph: Components['p']): boolean =>
  Children.toArray(node).some((child) => {
    if (!isValidElement(child)) return false
    if (child.type === 'p' || child.type === customParagraph || elementNodeTagName(child) === 'p') {
      return paragraphIsVisible(child, customParagraph)
    }
    return hasVisibleParagraph((child.props as { children?: ReactNode }).children, customParagraph)
  })

// Streaming-only blockquote override that replaces the `:has()`-based CSS rule, which re-matched
// against the whole quote subtree on every streamed DOM mutation. `base` is a caller-supplied
// blockquote component (kept in charge of its own chrome); `paragraph` is a caller-supplied
// paragraph component (exempt from the unwrap heuristic above).
const createStreamingBlockquote = (
  base: Components['blockquote'],
  paragraph: Components['p']
): ComponentType<StreamingBlockquoteProps> => {
  const StreamingBlockquote = (props: StreamingBlockquoteProps): React.JSX.Element => {
    const { children, className, ...rest } = props
    delete rest.node
    const hidden = hasVisibleParagraph(children, paragraph) ? null : 'hidden'
    if (base != null && typeof base !== 'string') {
      const Base = base
      return (
        <Base {...rest} className={cn(className, hidden)}>
          {children}
        </Base>
      )
    }
    // A string base names a host tag to render in place of `blockquote`.
    const Tag = (typeof base === 'string' ? base : 'blockquote') as 'blockquote'
    return (
      <Tag
        data-streamdown="blockquote"
        className={cn(DEFAULT_BLOCKQUOTE_CLASS, className, hidden)}
        {...rest}
      >
        {children}
      </Tag>
    )
  }
  return StreamingBlockquote
}

export { createStreamingBlockquote }
