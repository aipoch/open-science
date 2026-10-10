/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { root, spec, stageNativeComponents } from './native-components.mjs'

// install-app-deps scans binding.gyp even with gypfile:false and npmRebuild:false.
// Use its installed rebuilder's supported exclusion API to preserve our signed components.
export async function rebuildElectronDependencies(directory = root) {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
  const { rebuild } = await import(
    pathToFileURL(appBuilderRequire.resolve('@electron/rebuild')).href
  )
  await rebuild({
    buildPath: directory,
    projectRootPath: directory,
    electronVersion: require('electron/package.json').version,
    platform: process.platform,
    arch: process.arch,
    mode: 'sequential',
    disablePreGypCopy: true,
    // The rebuilder identifies linked file: packages by their real parent directory.
    ignoreModules: Object.keys(spec.packages).flatMap((name) => [
      `@aipoch/${name}`,
      `packages/${name}`
    ])
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageNativeComponents()
  await rebuildElectronDependencies()
}
