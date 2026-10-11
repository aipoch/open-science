/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { builtinModules } from 'node:module'

export const isElectronPackage = (name) =>
  /^(?:electron(?:$|\/|-)|@electron(?:-toolkit)?\/)/.test(name)
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

// node-gyp keeps compiler intermediates (e.g. *.o) in build/Release/obj.target. They are dead
// weight at runtime and, being unsigned Mach-O objects, break packaged signature verification —
// so dependency copies for the standalone backend must never include them.
export const isShippableDependencyPath = (relativePath) => {
  const parts = relativePath.split(/[\\/]/)
  return parts[0] !== 'node_modules' && parts[0] !== '.git' && !parts.includes('obj.target')
}

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

// Local file: dependencies are symlinks in development. Keep the independent packages' source/fixtures
// out of shipped runtimes, using its deliberately literal top-level npm files allowlist.
export function backendDependencyIncludes(manifest, relativePath) {
  const top = relativePath.split(/[\\/]/)[0]
  if (!isShippableDependencyPath(relativePath)) return false
  if (
    ![
      '@aipoch/pdf-structure',
      '@aipoch/pdf-translation',
      '@aipoch/literature-citations',
      '@aipoch/journal-catalog'
    ].includes(manifest.name) ||
    !top
  )
    return true
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.some((path) => !/^[a-zA-Z0-9_.-]+$/.test(path))
  )
    throw new Error('Independent package staging requires literal top-level files entries.')
  return top === 'package.json' || manifest.files.includes(top)
}
