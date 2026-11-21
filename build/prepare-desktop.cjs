/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const stageDesktopRuntime = require('./stage-desktop-runtime.cjs')

// Backend native components remain immutable catalog artifacts. Windows installation
// UI is supplied by NSIS; no independent update presentation executable is built.
module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch]
  if (context.electronPlatformName !== process.platform || arch !== process.arch)
    throw new Error('Build the desktop application on its target platform/architecture.')
  const {
    platformBackendOnlyElectronDependencies
  } = require('../scripts/electron-host-dependencies.mjs')
  const excluded = platformBackendOnlyElectronDependencies(context.electronPlatformName, arch)
  if (excluded.length) {
    // Extend the normalized root file set. A separate platform matcher can copy the project
    // tree independently of the root exclusions.
    const appFiles = context.packager.config.files.find((set) => !set.from && !set.to)
    if (!Array.isArray(appFiles?.filter)) throw new Error('Missing root application file filter.')
    for (const name of excluded) {
      const pattern = `!node_modules/${name}{,/**/*}`
      if (!appFiles.filter.includes(pattern)) appFiles.filter.push(pattern)
    }
  }
  if (context.electronPlatformName === 'win32' && arch === 'x64') {
    const path = require('node:path')
    const root = context.packager.projectDir
    require('node:child_process').execFileSync(
      'python',
      [path.join(root, 'build/windows-delta/build.py'), path.join(root, 'out/windows-delta', arch)],
      { stdio: 'inherit' }
    )
  }
  await stageDesktopRuntime(context)
}
