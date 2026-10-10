/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { builtinModules } from 'node:module'

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
