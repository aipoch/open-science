import { createRoot as createRootBase } from 'react-dom/client'
import { render as renderBase, renderHook as renderHookBase } from '@testing-library/react'
import { createElement, type JSXElementConstructor, type ReactNode, type ReactElement } from 'react'
import {
  LiteratureRendererProvider,
  type LiteratureRendererHost
} from '../../src/renderer/src/pages/literature/public/host'

/** Missing capabilities fail at use instead of silently importing the production application. */
export function createLiteratureTestRenderer(
  capabilities: Partial<LiteratureRendererHost>,
  Capture?: JSXElementConstructor<{ children: ReactNode }>
): {
  render: typeof renderBase
  renderHook: typeof renderHookBase
  createRoot: typeof createRootBase
} {
  const host = new Proxy(capabilities as LiteratureRendererHost, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !(key in target))
        throw new Error(`Literature test capability was not supplied: ${String(key)}`)
      return Reflect.get(target, key, receiver)
    }
  })
  const wrap = (Wrapper?: JSXElementConstructor<{ children: ReactNode }>) =>
    function LiteratureTestHost({ children }: { children: ReactNode }): React.JSX.Element {
      const content = Wrapper ? createElement(Wrapper, null, children) : children
      return createElement(
        LiteratureRendererProvider,
        { host },
        Capture ? createElement(Capture, null, content) : content
      )
    }
  const render: typeof renderBase = ((
    ui: ReactElement,
    options: NonNullable<Parameters<typeof renderBase>[1]> = {}
  ) => renderBase(ui, { ...options, wrapper: wrap(options.wrapper) })) as typeof renderBase
  const renderHook: typeof renderHookBase = ((callback, options = {}) =>
    renderHookBase(callback, {
      ...options,
      wrapper: wrap(options.wrapper)
    })) as typeof renderHookBase
  const createRoot: typeof createRootBase = (container, options) => {
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
  return { render, renderHook, createRoot }
}
