/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'

// These features execute in the separately staged Node backend. Keep this list aligned with
// electron-builder.yml; a new desktop consumer must restore its payload before it can build.
export const backendOnlyElectronDependencies = [
  '@aipoch/connector-builtins',
  '@aipoch/notebook-analysis',
  '@aipoch/notebook-code-risk',
  '@aipoch/notebook-syntax',
  '@aipoch/environment',
  '@aipoch/compute',
  '@aipoch/skills',
  '@aipoch/specialists',
  '@aipoch/journal-catalog',
  '@aipoch/literature-citations',
  '@aipoch/literature-discovery',
  '@aipoch/literature-library',
  '@aipoch/literature-reading',
  '@aipoch/literature-screening',
  '@aipoch/reproducibility',
  'styled-exceljs',
  'tar',
  'brotli',
  'pako',
  'unicode-trie',
  'protobufjs',
  'flatbuffers',
  'guid-typescript',
  'fflate',
  'tesseract.js',
  'tesseract.js-core',
  '@tesseract.js-data/eng',
  '@tesseract.js-data/chi_sim'
]

export function assertElectronHostDependencies(specifiers, root) {
  const visited = new Set()
  const visit = (specifier, from, chain) => {
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('node:') ||
      builtinModules.includes(specifier)
    )
      return
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    if (name === 'electron') return
    if (backendOnlyElectronDependencies.includes(name))
      throw new Error(
        `Electron host requires backend-only dependency: ${[...chain, name].join(' -> ')}`
      )
    let directory = from
    while (!existsSync(join(directory, 'node_modules', name, 'package.json'))) {
      const parent = dirname(directory)
      // Optional platform dependencies may not be installed on this build host.
      if (parent === directory) return
      directory = parent
    }
    const file = realpathSync(join(directory, 'node_modules', name, 'package.json'))
    if (visited.has(file)) return
    visited.add(file)
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    }))
      visit(dependency, dirname(file), [...chain, name])
  }
  for (const specifier of specifiers) visit(specifier, root, [])
}

export function electronHostDependencyGuard(root) {
  return {
    name: 'electron-host-dependency-boundary',
    generateBundle() {
      assertElectronHostDependencies(
        [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isExternal),
        root
      )
    }
  }
}
