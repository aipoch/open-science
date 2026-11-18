import { windowsSigningBuildDefines } from './windows-signing-policy.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  assertBackendImports,
  desktopBundledDependencies,
  desktopExternalClosure,
  assertBundledModulesStayPortable,
  missingOptionalDependencies
} from './backend-dependencies.mjs'
import { context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { wsl2BuildDefines } from './wsl2-build-flags.mjs'

// Bundled code may keep a guarded require of an optional package that is not installed (for
// example ws and bufferutil). Only names the bundled package itself marks optional qualify.
// Every third-party package compiled into the bundle ships its notice here. Workspace packages
// resolve without a node_modules segment and are covered by the application license.
async function bundledDependencyNotices(root, metafiles) {
  const directories = new Map()
  for (const meta of metafiles)
    for (const path of Object.keys(meta.inputs)) {
      const parts = path.split(/[\\/]/)
      const at = parts.lastIndexOf('node_modules')
      if (at < 0) continue
      const directory = join(root, ...parts.slice(0, at + (parts[at + 1].startsWith('@') ? 3 : 2)))
      directories.set(directory, true)
    }
  const notices = []
  for (const directory of directories.keys()) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const files = (await readdir(directory))
      .filter((name) => /^(?:licen[sc]e|notice|copying|copyright)/i.test(name))
      .sort()
    const id = manifest.name + '@' + manifest.version
    if (files.length)
      for (const file of files)
        notices.push(
          id + ' - ' + file + '\n\n' + (await readFile(join(directory, file), 'utf8')).trim()
        )
    else if (typeof manifest.license === 'string' && manifest.license.trim())
      notices.push(
        [
          id + ' - package.json',
          'License: ' + manifest.license,
          manifest.author && 'Author: ' + (manifest.author.name ?? manifest.author),
          manifest.repository && 'Repository: ' + (manifest.repository.url ?? manifest.repository)
        ]
          .filter(Boolean)
          .join('\n')
      )
    else throw new Error('Missing bundled dependency license: ' + id)
  }
  return notices.sort((a, b) => a.localeCompare(b))
}

export async function createBackendBuilder({
  root = resolve(import.meta.dirname, '..'),
  development = false,
  desktop = false
} = {}) {
  const out = join(root, desktop ? 'out/desktop-backend-build' : 'out/backend')
  const external = desktop ? desktopExternalClosure(root) : undefined
  await mkdir(out, { recursive: true })
  const workers = new Map()
  const contexts = new Map()
  let metadata = []
  const buildEntry = async (entry, outfile) => {
    let builder = contexts.get(entry)
    if (!builder) {
      builder = await context({
        absWorkingDir: root,
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        ...(desktop ? {} : { packages: 'external' }),
        metafile: true,
        sourcemap: true,
        loader: { '.md': 'text' },
        define: {
          'import.meta.url': '__entryUrl',
          __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__: JSON.stringify('native-locales'),
          ...windowsSigningBuildDefines(process.env),
          ...wsl2BuildDefines(process.platform, development, process.env)
        },
        banner: {
          js: `${entry === join(root, 'src/main/node-entry.ts') ? `(() => { const module = { exports: {} }; ${await readFile(join(root, 'packages/open-science/installation-startup.cjs'), 'utf8')} globalThis[Symbol.for('open-science.installation-bootstrap')] = module.exports.protectInstallationStartup(__filename, process.env.OPEN_SCIENCE_CONFIG_ROOT || 'bootstrap'); })();` : ''}\nconst __entryUrl = require("node:url").pathToFileURL(__filename).href;`
        },
        plugins: [
          {
            name: 'open-science-node-resources',
            setup(plugin) {
              if (external)
                plugin.onResolve({ filter: /^(?:@[^/]+\/[^/]+|[^@./][^/]*)(?:\/|$)/ }, (args) => {
                  const name = args.path.startsWith('@')
                    ? args.path.split('/').slice(0, 2).join('/')
                    : args.path.split('/')[0]
                  if (external.has(name)) return { path: args.path, external: true }
                  return undefined
                })
              plugin.onResolve({ filter: /^@aipoch\/notebook-network-sandbox$/ }, () => ({
                path: join(root, 'packages/notebook-network-sandbox/src/index.ts')
              }))
              // Subpath consumers must stay inlined too: stage-backend deliberately never ships
              // this package, so any runtime require of it fails in packaged CLI and desktop apps.
              plugin.onResolve(
                { filter: /^@aipoch\/notebook-network-sandbox\/network-address$/ },
                () => ({
                  path: join(root, 'packages/notebook-network-sandbox/src/network-address.ts')
                })
              )
              plugin.onResolve({ filter: /\?nodeWorker$/ }, ({ path, resolveDir }) => ({
                path: resolve(resolveDir, path.slice(0, -11) + '.ts'),
                namespace: 'node-worker'
              }))
              plugin.onLoad({ filter: /.*/, namespace: 'node-worker' }, ({ path }) => {
                // Only fixed text and hexadecimal enter the generated JavaScript literal.
                const name = `worker-${createHash('sha256').update(path.slice(root.length)).digest('hex')}.cjs`
                workers.set(path, name)
                return {
                  contents: `import { Worker } from 'node:worker_threads'; import { join } from 'node:path'; export default (options) => new Worker(join(__dirname, '${name}'), options);`,
                  loader: 'js'
                }
              })
              plugin.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({
                path: resolve(resolveDir, path.slice(0, -4)),
                namespace: 'raw-resource'
              }))
              plugin.onLoad({ filter: /.*/, namespace: 'raw-resource' }, async ({ path }) => ({
                contents: await readFile(path, 'utf8'),
                loader: 'text',
                watchFiles: [path]
              }))
            }
          }
        ]
      })
      contexts.set(entry, builder)
    }
    const result = await builder.rebuild()
    metadata.push(result.metafile)
  }
  // Bundled modules that start a worker from a file beside themselves. When the module is in
  // the bundle, its worker is compiled beside index.cjs so join(__dirname, name) still finds it.
  const fileWorkerSources = desktop
    ? [
        {
          caller: 'packages/compute/dist/hugging-face-bucket.js',
          entry: 'packages/compute/dist/hugging-face-bucket-worker.js',
          name: 'hugging-face-bucket-worker.js'
        }
      ]
    : []
  let fileWorkers = []
  const rebuild = async () => {
    workers.clear()
    metadata = []
    await buildEntry(join(root, 'src/main/node-entry.ts'), join(out, 'index.cjs'))
    for (const [entry, name] of workers) await buildEntry(entry, join(out, name))
    const bundledInputs = new Set(
      metadata.flatMap((meta) => Object.keys(meta.inputs).map((path) => path.replaceAll('\\', '/')))
    )
    fileWorkers = fileWorkerSources
      .filter(({ caller }) => bundledInputs.has(caller))
      .map(({ entry, name }) => [join(root, entry), name])
    for (const [entry, name] of fileWorkers) await buildEntry(entry, join(out, name))
    for (const [entry, builder] of contexts) {
      if (
        entry !== join(root, 'src/main/node-entry.ts') &&
        !workers.has(entry) &&
        !fileWorkers.some(([file]) => file === entry)
      ) {
        await builder.dispose()
        contexts.delete(entry)
      }
    }
    assertBackendImports(
      metadata,
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies,
      external && new Set([...external, ...missingOptionalDependencies(root, metadata)])
    )
    desktopBundledDependencies(metadata, external, root)
    if (desktop)
      assertBundledModulesStayPortable(
        metadata,
        root,
        new Set([...external, ...missingOptionalDependencies(root, metadata)])
      )
    if (desktop) {
      await rm(join(out, 'third-party-licenses'), { recursive: true, force: true })
      const notices = await bundledDependencyNotices(root, metadata)
      if (notices.length) {
        await mkdir(join(out, 'third-party-licenses'), { recursive: true })
        await writeFile(
          join(out, 'third-party-licenses/THIRD-PARTY-NOTICES.txt'),
          notices.join('\n\n---\n\n') + '\n'
        )
      }
    }
    // The staged backend package is an ES module scope. Compiled file workers keep their
    // published .js names, so pin this directory to CommonJS like the .cjs entry points.
    if (fileWorkers.length)
      await writeFile(join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')
    else if (desktop) await rm(join(out, 'package.json'), { force: true })
    await mkdir(join(out, 'native-locales'), { recursive: true })
    for (const file of await readdir(join(root, 'src/shared/i18n/locales'))) {
      if (!file.endsWith('.json')) continue
      const { common, native } = JSON.parse(
        await readFile(join(root, 'src/shared/i18n/locales', file), 'utf8')
      )
      await writeFile(join(out, 'native-locales', file), JSON.stringify({ common, native }))
    }
    await writeFile(join(out, 'dependencies.json'), JSON.stringify(metadata, null, 2))
    return workers.size
  }
  return {
    rebuild,
    dispose: () => Promise.all([...contexts.values()].map((builder) => builder.dispose()))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const builder = await createBackendBuilder({
    development: process.argv.includes('--development'),
    desktop: process.argv.includes('--desktop')
  })
  try {
    const workers = await builder.rebuild()
    console.log(`Built Node backend and ${workers} workers without Electron imports.`)
  } finally {
    await builder.dispose()
  }
}
