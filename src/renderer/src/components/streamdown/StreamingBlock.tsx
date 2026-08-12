import { createContext, useContext, useMemo, type ComponentProps, type ComponentType } from 'react'
import {
  Block,
  CodeBlockContainer,
  CodeBlockHeader,
  type BlockProps,
  type ExtraProps
} from 'streamdown'

import {
  getUnclosedTrailingFence,
  stripTrailingNewlines,
  type TrailingCodeFence
} from './unclosed-trailing-fence'

type DefaultCodeComponent = ComponentType<ComponentProps<'code'> & ExtraProps>

type StreamingCodeContextValue = {
  defaultCode: DefaultCodeComponent
  trailing: TrailingCodeFence
}

const StreamingCodeContext = createContext<StreamingCodeContextValue | null>(null)

// Plain stand-in for Streamdown's CodeBlock: same chrome (container + language header) but no
// Shiki highlighting, so the growing fence stays cheap to render.
const StreamingCodeBlockView = ({ language, code }: TrailingCodeFence): React.JSX.Element => (
  <CodeBlockContainer language={language} isIncomplete>
    <CodeBlockHeader language={language} />
    <div
      data-streamdown="code-block-body"
      data-language={language}
      className="overflow-x-auto rounded-md border border-border bg-background p-4 text-sm"
    >
      <pre className="m-0 font-mono">{code}</pre>
    </div>
  </CodeBlockContainer>
)

// Renders the trailing unclosed fence as plain text while streaming; every other code element
// (inline code, closed fences, earlier blocks) delegates to Streamdown's own component.
const MaybeStreamingCode = (
  props: ComponentProps<'code'> & ExtraProps & { 'data-block'?: string | boolean }
): React.JSX.Element => {
  const context = useContext(StreamingCodeContext)
  const DefaultCode = context?.defaultCode

  const className = typeof props.className === 'string' ? props.className : ''
  const language = /language-(\S+)/.exec(className)?.[1] ?? ''
  const text = typeof props.children === 'string' ? props.children : ''

  // A closed fence earlier in the same block with the same language and identical source would
  // also match; that is rare and only costs highlighting until the trailing fence closes.
  const isTrailingFence =
    context !== null &&
    'data-block' in props &&
    language === context.trailing.language &&
    stripTrailingNewlines(text) === context.trailing.code

  if (isTrailingFence) {
    return <StreamingCodeBlockView language={language} code={text} />
  }

  return DefaultCode ? <DefaultCode {...props} /> : <code {...props} />
}

// Streamdown re-highlights an unclosed trailing code fence with Shiki on every streamed commit
// (@streamdown/code caches by full source, so a growing block never hits the cache). While the
// last block is incomplete, this BlockComponent swaps just that fence for a cheap plain render;
// closing the fence or finishing the message restores full highlighting. Mermaid fences keep
// Streamdown's default handling because they have their own incomplete state.
const StreamingBlock = (props: BlockProps): React.JSX.Element => {
  const { components, content, isIncomplete } = props

  const trailing = useMemo(
    () => (isIncomplete ? getUnclosedTrailingFence(content) : null),
    [content, isIncomplete]
  )

  const override = useMemo((): StreamingCodeContextValue | null => {
    const defaultCode = components?.code
    if (!trailing || trailing.language === 'mermaid') return null
    // Streamdown's default is a `memo()` object; a string tag would mean no code component.
    if (defaultCode == null || typeof defaultCode === 'string') return null
    return { defaultCode, trailing }
  }, [components, trailing])

  if (!override || !components) return <Block {...props} />

  return (
    <StreamingCodeContext.Provider value={override}>
      <Block {...props} components={{ ...components, code: MaybeStreamingCode }} />
    </StreamingCodeContext.Provider>
  )
}

export { StreamingBlock }
