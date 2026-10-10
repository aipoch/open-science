/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Native backend resources are target artifacts, not Electron-rebuilt addons. Refuse accidental
// cross packaging instead of silently shipping the build host's incompatible executables.
module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch]
  if (context.electronPlatformName !== process.platform || arch !== process.arch)
    throw new Error('Build the desktop Node backend on its target platform/architecture.')
  const root = context.packager.projectDir
  for (const [script, args] of [
    [
      require.resolve('node-gyp/bin/node-gyp.js'),
      [
        'rebuild',
        '--directory',
        'packages/credential-identity-probe-native',
        '--',
        '-Dbuild_node_secret=1'
      ]
    ],
    [path.join(root, 'scripts/build-backend.mjs'), []]
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' })
    if (result.error || result.status !== 0)
      throw result.error || new Error('Desktop backend build failed.')
  }
  const { stageNodeRuntime } = await import(
    pathToFileURL(path.join(root, 'scripts/stage-node-runtime.mjs')).href
  )
  await stageNodeRuntime({ platform: process.platform, arch })
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/stage-backend.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.error || result.status !== 0)
    throw result.error || new Error('Desktop backend staging failed.')
}
