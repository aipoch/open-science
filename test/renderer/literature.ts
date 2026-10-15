import { createRoot as createRootBase } from 'react-dom/client'
export type { Root, RootOptions } from 'react-dom/client'
import { useAttachmentOperationsStore } from '../../src/renderer/src/pages/literature/workflows/literature-attachment-operations'
import { useJournalStore } from '../../src/renderer/src/pages/literature/journals/journal-attribute-store'
import { render as renderBase, renderHook as renderHookBase } from '@testing-library/react'
import {
  createElement,
  useLayoutEffect,
  type JSXElementConstructor,
  type ReactNode,
  type ReactElement
} from 'react'
import { LiteratureRendererProvider } from '../../src/renderer/src/pages/literature/public/host'
import { literatureRendererHost } from '../../src/renderer/src/lib/literature-renderer-host'
export * from '@testing-library/react'

export let testAttachmentOperations: ReturnType<typeof useAttachmentOperationsStore>
export let testJournalStore: ReturnType<typeof useJournalStore>
function Capture({ children }: { children?: ReactNode }): ReactNode {
  const operations = useAttachmentOperationsStore()
  const journals = useJournalStore()
  useLayoutEffect(() => {
    testAttachmentOperations = operations
    testJournalStore = journals
  }, [operations, journals])
  return children
}
const wrap = (
  Wrapper?: JSXElementConstructor<{ children: ReactNode }>
): JSXElementConstructor<{ children: ReactNode }> =>
  function LiteratureTestHost({ children }: { children: ReactNode }): React.JSX.Element {
    return createElement(
      LiteratureRendererProvider,
      { host: literatureRendererHost },
      createElement(Capture, null, Wrapper ? createElement(Wrapper, null, children) : children)
    )
  }

export const render: typeof renderBase = ((
  ui: ReactElement,
  options: NonNullable<Parameters<typeof renderBase>[1]> = {}
) => renderBase(ui, { ...options, wrapper: wrap(options.wrapper) })) as typeof renderBase
export const renderHook: typeof renderHookBase = ((callback, options = {}) =>
  renderHookBase(callback, { ...options, wrapper: wrap(options.wrapper) })) as typeof renderHookBase

export const createRoot: typeof createRootBase = (container, options) => {
  const root = createRootBase(container, options)
  const Wrapper = wrap()
  return {
    render(children) {
      root.render(createElement(Wrapper, null, children))
    },
    unmount() {
      root.unmount()
    }
  }
}
