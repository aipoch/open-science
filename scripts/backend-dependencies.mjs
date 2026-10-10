/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { realpathSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

export const isElectronPackage = (name) =>
  /^(?:electron(?:$|\/|-)|@electron(?:-toolkit)?\/)/.test(name)
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

// esbuild inputs cover the entire reachable source/worker graph; outputs record actual external
// runtime imports after type erasure. Packaging independently walks every dependency and peer.
export function assertBackendImports(metafiles, dependencies) {
  for (const meta of metafiles) {
    for (const [source, input] of Object.entries(meta.inputs)) {
      for (const item of input.imports) {
        if (isElectronPackage(item.path))
          throw new Error(`Node backend imports Electron: ${source} -> ${item.path}`)
      }
    }
    for (const [output, value] of Object.entries(meta.outputs)) {
      for (const item of value.imports) {
        if (
          !item.external ||
          item.path.startsWith('node:') ||
          builtinModules.includes(item.path) ||
          item.path.startsWith('.')
        )
          continue
        const name = packageName(item.path)
        if (isElectronPackage(name))
          throw new Error(`Node backend imports Electron: ${output} -> ${name}`)
        if (!(name in dependencies))
          throw new Error(`Backend dependency must be declared for production: ${name}`)
      }
    }
  }
}

// A declared dependency can still be omitted from the staged artifact. Resolve from the actual
// backend location, and reject ancestor node_modules or symlinks back to the source checkout.
export function assertStagedBackendImports(stage, metafiles) {
  const directory = realpathSync(stage)
  const stagedRequire = createRequire(join(directory, 'out/backend/index.cjs'))
  const specifiers = new Set()
  for (const meta of metafiles) {
    for (const output of Object.values(meta.outputs)) {
      for (const item of output.imports) {
        if (
          item.external &&
          !item.path.startsWith('node:') &&
          !builtinModules.includes(item.path) &&
          !item.path.startsWith('.')
        )
          specifiers.add(item.path)
      }
    }
  }
  for (const specifier of specifiers) {
    const resolved = realpathSync(stagedRequire.resolve(specifier))
    const path = relative(directory, resolved)
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`Backend dependency resolves outside the staged artifact: ${specifier}`)
  }
}
