// Starts panel code and first-view data together. Data failures stay owned by the panel's existing
// error/retry UI, while chunk failures continue to the Settings error boundary.
export const loadSettingsPanel = async <Module>(
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
