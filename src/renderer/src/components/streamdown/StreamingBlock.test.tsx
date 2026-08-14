// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtraProps } from 'streamdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const streamdownHarness = vi.hoisted(() => ({
  blockProps: undefined as Record<string, unknown> | undefined,
  codeClassName: 'language-js',
  codeText: 'const a = 1',
  codeDataBlock: true
}))

vi.mock('streamdown', () => ({
  Block: (props: Record<string, unknown>): React.JSX.Element => {
    streamdownHarness.blockProps = props
    const components = props.components as Record<
      string,
      React.ComponentType<Record<string, unknown>>
    >
    const Code = components?.code
    return (
      <div data-testid="block">
        {Code ? (
          <Code
            className={streamdownHarness.codeClassName}
            {...(streamdownHarness.codeDataBlock ? { 'data-block': 'true' } : {})}
          >
            {streamdownHarness.codeText}
          </Code>
        ) : null}
      </div>
    )
  },
  CodeBlockContainer: ({
    children,
    language,
    isIncomplete
  }: React.PropsWithChildren<{ language: string; isIncomplete?: boolean }>): React.JSX.Element => (
    <div data-streamdown="code-block" data-language={language} data-incomplete={isIncomplete}>
      {children}
    </div>
  ),
  CodeBlockHeader: ({ language }: { language: string }): React.JSX.Element => (
    <div data-streamdown="code-block-header">{language}</div>
  )
}))

const { StreamingBlock } = await import('./StreamingBlock')
const { getUnclosedTrailingFence } = await import('./unclosed-trailing-fence')

const DefaultCode = (props: ComponentProps<'code'> & ExtraProps): React.JSX.Element => (
  <code data-testid="default-code">{props.children}</code>
)

const renderBlock = (root: Root, props: { content: string; isIncomplete: boolean }): void => {
  act(() => {
    root.render(
      <StreamingBlock
        components={{ code: DefaultCode }}
        content={props.content}
        dir="ltr"
        index={0}
        isIncomplete={props.isIncomplete}
        shouldNormalizeHtmlIndentation={false}
        shouldParseIncompleteMarkdown
      />
    )
  })
}

describe('getUnclosedTrailingFence', () => {
  it('returns the language and source of an unclosed trailing fence', () => {
    expect(getUnclosedTrailingFence('text\n\n```js\nconst a = 1')).toEqual({
      language: 'js',
      code: 'const a = 1'
    })
  })

  it('returns null when every fence is closed', () => {
    expect(getUnclosedTrailingFence('```js\nconst a = 1\n```\n\ntext')).toBeNull()
  })

  it('trims trailing newlines from the partial source', () => {
    expect(getUnclosedTrailingFence('```py\nprint(1)\n')?.code).toBe('print(1)')
  })

  it('handles tildes and longer closing fences', () => {
    expect(getUnclosedTrailingFence('~~~~ts\nlet x: number')).toEqual({
      language: 'ts',
      code: 'let x: number'
    })
    expect(getUnclosedTrailingFence('````\n```\nstill open')).toEqual({
      language: '',
      code: '```\nstill open'
    })
  })
})

describe('StreamingBlock', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    streamdownHarness.blockProps = undefined
    streamdownHarness.codeClassName = 'language-js'
    streamdownHarness.codeText = 'const a = 1'
    streamdownHarness.codeDataBlock = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('passes components through untouched when the block is complete', () => {
    renderBlock(root, { content: '```js\nconst a = 1', isIncomplete: false })

    const components = streamdownHarness.blockProps?.components as Record<string, unknown>
    expect(components.code).toBe(DefaultCode)
    expect(container.querySelector('[data-testid="default-code"]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull()
  })

  it('renders the trailing unclosed fence as plain text without Shiki', () => {
    renderBlock(root, { content: '```js\nconst a = 1', isIncomplete: true })

    expect(container.querySelector('[data-testid="default-code"]')).toBeNull()
    const block = container.querySelector('[data-streamdown="code-block"]')
    expect(block?.getAttribute('data-language')).toBe('js')
    expect(block?.getAttribute('data-incomplete')).toBe('true')
    expect(container.querySelector('[data-streamdown="code-block"] pre')?.textContent).toBe(
      'const a = 1'
    )
  })

  it('delegates code elements that are not the trailing fence to the default component', () => {
    streamdownHarness.codeText = 'const other = 2'
    renderBlock(root, { content: '```js\nconst a = 1', isIncomplete: true })

    expect(container.querySelector('[data-testid="default-code"]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull()
  })

  it('delegates inline code to the default component', () => {
    streamdownHarness.codeDataBlock = false
    renderBlock(root, { content: '```js\nconst a = 1', isIncomplete: true })

    expect(container.querySelector('[data-testid="default-code"]')).not.toBeNull()
  })

  it('keeps the default component for an unclosed mermaid fence', () => {
    streamdownHarness.codeClassName = 'language-mermaid'
    streamdownHarness.codeText = 'xychart-beta'
    renderBlock(root, { content: '```mermaid\nxychart-beta', isIncomplete: true })

    const components = streamdownHarness.blockProps?.components as Record<string, unknown>
    expect(components.code).toBe(DefaultCode)
    expect(container.querySelector('[data-testid="default-code"]')).not.toBeNull()
  })
})
