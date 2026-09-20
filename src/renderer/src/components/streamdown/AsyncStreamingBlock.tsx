import { useContext, useEffect, useMemo, useState } from 'react'
import { normalizeHtmlIndentation, StreamdownContext, type BlockProps } from 'streamdown'

import {
  createMarkdownParseOwner,
  getMarkdownParseCost,
  isMarkdownParserReady,
  MARKDOWN_PARSE_BUDGET_MS,
  reuseMarkdownParse
} from './markdown-parser'
import { StreamingBlock } from './StreamingBlock'

// Only AgentMarkdown uses this adapter: its GFM/CJK/math syntax is the Worker's fixed contract.
export const AsyncStreamingBlock = (props: BlockProps): React.JSX.Element => {
  const { isAnimating } = useContext(StreamdownContext)
  const source = props.shouldNormalizeHtmlIndentation
    ? normalizeHtmlIndentation(props.content)
    : props.content
  const [owner] = useState(createMarkdownParseOwner)
  const [failed, setFailed] = useState(false)
  const [state, setState] = useState({
    input: source,
    streaming: isAnimating,
    async: false,
    displayed: source
  })
  if (state.input !== source || state.streaming !== isAnimating) {
    const async = Boolean(
      isAnimating &&
      !failed &&
      isMarkdownParserReady() &&
      source.startsWith(state.input) &&
      (state.async || getMarkdownParseCost(state.input) >= MARKDOWN_PARSE_BUDGET_MS)
    )
    setState({
      input: source,
      streaming: isAnimating,
      async,
      displayed: async ? state.displayed : source
    })
  }
  const asynchronous = state.async && isAnimating && !failed
  const remarkPlugins = useMemo(
    () => [...(props.remarkPlugins ?? []), reuseMarkdownParse],
    [props.remarkPlugins]
  )
  useEffect(() => () => owner.dispose(), [owner])
  useEffect(() => {
    if (!asynchronous) {
      owner.cancel()
      return
    }
    owner.request(
      source,
      (parsedSource) => {
        // Accept monotonic progress during a fast append stream, but never a result from an edit,
        // replaced branch or terminalized block. Newer queued text remains intact.
        setState((current) =>
          current.async &&
          current.streaming &&
          current.input.startsWith(parsedSource) &&
          parsedSource.length >= current.displayed.length
            ? { ...current, displayed: parsedSource }
            : current
        )
      },
      () => setFailed(true)
    )
  }, [asynchronous, owner, source])

  // Terminal content is synchronous unless its exact tree is ready. This keeps the existing
  // presentation barrier valid, including cancellation/error completion; no new business state.
  return (
    <StreamingBlock
      {...props}
      content={asynchronous ? state.displayed : source}
      shouldNormalizeHtmlIndentation={false}
      remarkPlugins={remarkPlugins}
    />
  )
}
