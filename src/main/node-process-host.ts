// A desktop helper reuses Electron's Node mode; a standalone helper runs the current ordinary Node
// executable. An explicit undefined removes an inherited Electron flag from spawn environments.
export const nodeRuntimeEnvironment = (): NodeJS.ProcessEnv => ({
  ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : undefined,
  ...Object.fromEntries(
    [
      'OPEN_SCIENCE_HOST_HOME',
      'OPEN_SCIENCE_APPLICATION_PATH',
      'OPEN_SCIENCE_RESOURCES_PATH',
      'OPEN_SCIENCE_APPLICATION_VERSION',
      'OPEN_SCIENCE_HOST_PACKAGED'
    ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  )
})

export const nodeRuntimeEnvironmentEntries = (): Array<{ name: string; value: string }> =>
  Object.entries(nodeRuntimeEnvironment()).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }]
  )
