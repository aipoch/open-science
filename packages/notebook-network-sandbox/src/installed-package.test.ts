import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the installed sandbox without reaching outside its package for configuration', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'installed-notebook-sandbox-')))
  try {
    // Materialize the local file dependency as npm does (not a source-tree symlink). No sibling
    // application src/ tree is present, so an out-of-package relative import cannot be concealed.
    const installed = join(fixture, 'node_modules', '@aipoch', 'notebook-network-sandbox')
    mkdirSync(join(fixture, 'node_modules', '@aipoch'), { recursive: true })
    cpSync(fileURLToPath(new URL('..', import.meta.url)), installed, { recursive: true })
    // This private source package is shipped by the application, which declares its runtime
    // dependencies. Copy their installed dependency closure, not links back to the checkout.
    const applicationManifest = fileURLToPath(new URL('../../../package.json', import.meta.url))
    const dependenciesRoot = join(dirname(applicationManifest), 'node_modules')
    const copied = new Set<string>()
    const installDependency = (name: string, from: NodeRequire): void => {
      const manifest = from.resolve
        .paths(name)
        ?.map((directory) => join(directory, name, 'package.json'))
        .find(existsSync)
      if (!manifest) throw new Error(`Installed fixture dependency is unavailable: ${name}`)
      if (copied.has(manifest)) return
      copied.add(manifest)
      const source = dirname(manifest)
      expect(source.startsWith(dependenciesRoot + sep)).toBe(true)
      // Preserve nested versions and npm's lookup layout instead of flattening unlike versions.
      cpSync(source, join(fixture, 'node_modules', relative(dependenciesRoot, source)), {
        recursive: true,
        dereference: true,
        filter: (path) => path !== join(source, 'node_modules')
      })
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>
      }
      for (const dependency of Object.keys(pkg.dependencies ?? {})) {
        installDependency(dependency, createRequire(manifest))
      }
    }
    const application = JSON.parse(readFileSync(applicationManifest, 'utf8')) as {
      dependencies: Record<string, string>
    }
    for (const name of ['reflect-metadata', '@peculiar/x509']) {
      expect(typeof application.dependencies[name]).toBe('string')
      installDependency(name, createRequire(applicationManifest))
    }
    const entry = join(fixture, 'entry.ts')
    writeFileSync(
      entry,
      `
      import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
      import { createRuntimeConfig } from './node_modules/@aipoch/notebook-network-sandbox/src/config.js'
      const config = createRuntimeConfig({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: ${JSON.stringify(join(fixture, 'resources'))} },
        packaged: false
      }, 'x64', { OPEN_SCIENCE_STORAGE_ROOT: ${JSON.stringify(join(fixture, 'config'))} })
      console.log(JSON.stringify({ loaded: typeof NotebookNetworkSandbox, root: config.windowsOwnershipRoot }))
    `
    )
    const bundle = join(fixture, 'entry.cjs')
    const built = buildSync({
      absWorkingDir: fixture,
      metafile: true,
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
    // Even a temp directory below the checkout must not resolve a missing fixture dependency
    // from an ancestor node_modules. Check every bundled input, including transitive imports.
    expect(
      Object.keys(built.metafile.inputs).filter(
        (path) => !resolve(fixture, path).startsWith(fixture + sep)
      )
    ).toEqual([])
    const result = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }))
    expect(result).toEqual({
      loaded: 'function',
      root: join(fixture, 'config', 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
