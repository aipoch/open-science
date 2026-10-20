/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const stageDesktopRuntime = require('./stage-desktop-runtime.cjs')

// Backend native components remain immutable catalog artifacts. Windows installation
// UI is supplied by NSIS; no independent update presentation executable is built.
module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch]
  if (context.electronPlatformName !== process.platform || arch !== process.arch)
    throw new Error('Build the desktop application on its target platform/architecture.')
  await stageDesktopRuntime(context)
}
