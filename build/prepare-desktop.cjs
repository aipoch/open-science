/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const stageDesktopRuntime = require('./stage-desktop-runtime.cjs')

// The application-owned update UI is built with the app. Backend native components
// remain immutable catalog artifacts staged by their existing owner below.
module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch]
  if (context.electronPlatformName !== process.platform || arch !== process.arch)
    throw new Error('Build the desktop application on its target platform/architecture.')
  const root = context.packager.projectDir
  if (process.platform === 'win32') {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('node-gyp/bin/node-gyp.js'),
        'rebuild',
        '--directory',
        path.join(root, 'build/windows-update-progress')
      ],
      { cwd: root, stdio: 'inherit' }
    )
    if (result.error || result.status !== 0)
      throw result.error || new Error('Windows update progress build failed.')
  }
  await stageDesktopRuntime(context)
}
