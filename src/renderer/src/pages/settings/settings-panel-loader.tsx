import { createContext, lazy, useContext, type ComponentType } from 'react'

// Starts panel code and first-view data together. Data failures stay owned by the panel's existing
// error/retry UI, while chunk failures continue to the Settings error boundary.
export const loadSettingsPanel = async <Module,>(
  loadModule: () => Promise<Module>,
  preload?: () => Promise<unknown>
): Promise<Module> => {
  const moduleRequest = loadModule()
  const preloadRequest = preload
    ? Promise.resolve()
        .then(preload)
        .catch(() => undefined)
    : Promise.resolve()
  const [module] = await Promise.all([moduleRequest, preloadRequest])
  return module
}

// In-place retry counter provided by SettingsPanelLoadingBoundary. Bumping it hands every panel a
// fresh lazy identity (see below).
export const SettingsPanelRetryContext = createContext(0)

// React.lazy caches a rejected import on the component instance, so remounting a module-level lazy
// rethrows the stale rejection and an in-place Retry could never recover a chunk-load failure.
// Each panel wraps its loader in a lazy instance keyed by the boundary's retry counter, so every
// Retry genuinely re-invokes the import. The cache lives in the factory closure, not in hook state:
// a suspending subtree never commits, so any lazy created in its render would be discarded on every
// Suspense retry and the loader would re-run in a loop.
export const lazyWithRetry = <Props extends object>(
  loader: () => Promise<{ default: ComponentType<Props> }>
): ComponentType<Props> => {
  let current: { retryKey: number; Panel: ComponentType<Props> } | undefined
  const RetryableLazyPanel = (props: Props): React.JSX.Element => {
    const retryKey = useContext(SettingsPanelRetryContext)
    if (current?.retryKey !== retryKey) current = { retryKey, Panel: lazy(loader) }
    const Panel = current.Panel
    return <Panel {...props} />
  }
  return RetryableLazyPanel
}
