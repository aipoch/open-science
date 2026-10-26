import { windowsSigningBuildDefines } from './windows-signing-policy.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { assertBackendImports, desktopBundledDependencies } from './backend-dependencies.mjs'
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { wsl2BuildDefines } from './wsl2-build-flags.mjs'

// The local text worker already injects this exact WASM implementation. Bundle only its
// Transformers consumer so the unused native/WebGPU imports do not become installation roots.
export async function buildLocalTranslationWorker(root, destination) {
  const require = createRequire(join(root, 'package.json'))
  const entry = require.resolve('@huggingface/transformers')
  const directory = resolve(entry, '../..')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== '4.2.0') return undefined
  const fromTransformers = createRequire(join(directory, 'package.json'))
  const wasmDirectory = resolve(fromTransformers.resolve('onnxruntime-web'), '../..')
  const wasmManifest = JSON.parse(await readFile(join(wasmDirectory, 'package.json'), 'utf8'))
  if (wasmManifest.version !== '1.26.0-dev.20260416-b7804b056c') return undefined
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'resources/pdf-translation-local/worker.mjs')],
    outfile: join(destination, 'worker.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
    metafile: true,
    plugins: [
      {
        name: 'local-translation-wasm',
        setup(plugin) {
          plugin.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
            path: join(directory, 'dist/transformers.node.mjs')
          }))
          plugin.onResolve({ filter: /^(?:onnxruntime-node|onnxruntime-web\/webgpu)$/ }, () => ({
            path: 'onnxruntime-web/wasm',
            external: true
          }))
        }
      }
    ]
  })
  const dependencies = [
    ...new Set(
      Object.values(result.metafile.outputs).flatMap((output) =>
        output.imports
          .filter(
            (item) =>
              item.external && !item.path.startsWith('node:') && !builtinModules.includes(item.path)
          )
          .map((item) =>
            item.path.startsWith('@')
              ? item.path.split('/').slice(0, 2).join('/')
              : item.path.split('/')[0]
          )
      )
    )
  ]
  if (dependencies.some((name) => ['onnxruntime-node', '@huggingface/transformers'].includes(name)))
    throw new Error('Local translation bundle retains an unpruned inference dependency.')
  // Preserve the worker's direct Tensor version before ORT Web installs its own nested version.
  dependencies.sort((a, b) =>
    a === 'onnxruntime-common' ? -1 : b === 'onnxruntime-common' ? 1 : 0
  )
  await writeFile(
    join(destination, 'transformers-LICENSE'),
    await readFile(join(directory, 'LICENSE'))
  )
  // These libraries are already embedded in the upstream Node bundle; their now-unused
  // package directories must not be the only place their redistribution notices survive.
  for (const name of ['jinja', 'tokenizers']) {
    const packageDirectory = resolve(fromTransformers.resolve(`@huggingface/${name}`), '../..')
    await writeFile(
      join(destination, `${name}-LICENSE`),
      await readFile(join(packageDirectory, 'LICENSE'))
    )
  }
  return { directory, dependencies, metafile: result.metafile }
}

export async function createBackendBuilder({
  root = resolve(import.meta.dirname, '..'),
  development = false,
  desktop = false
} = {}) {
  const out = join(root, desktop ? 'out/desktop-backend-build' : 'out/backend')
  const require = createRequire(join(root, 'package.json'))
  // Only this audited, resource-free CJS implementation is inlined. New versions remain
  // external until their runtime behavior and dependency graph have been checked again.
  const inlineI18next =
    desktop &&
    JSON.parse(await readFile(require.resolve('i18next/package.json'), 'utf8')).version ===
      '25.10.10'
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
        packages: 'external',
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
              if (inlineI18next)
                plugin.onResolve({ filter: /^i18next$/ }, () => ({
                  path: require.resolve('i18next')
                }))
              plugin.onResolve({ filter: /^@aipoch\/notebook-network-sandbox$/ }, () => ({
                path: join(root, 'packages/notebook-network-sandbox/src/index.ts')
              }))
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
  const rebuild = async () => {
    workers.clear()
    metadata = []
    await buildEntry(join(root, 'src/main/node-entry.ts'), join(out, 'index.cjs'))
    for (const [entry, name] of workers) await buildEntry(entry, join(out, name))
    for (const [entry, builder] of contexts) {
      if (entry !== join(root, 'src/main/node-entry.ts') && !workers.has(entry)) {
        await builder.dispose()
        contexts.delete(entry)
      }
    }
    assertBackendImports(
      metadata,
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies
    )
    if (desktopBundledDependencies(metadata).has('i18next')) {
      await mkdir(join(out, 'third-party-licenses'), { recursive: true })
      await writeFile(
        join(out, 'third-party-licenses/i18next-LICENSE'),
        await readFile(join(require.resolve('i18next/package.json'), '..', 'LICENSE'))
      )
    } else if (desktop) {
      await rm(join(out, 'third-party-licenses/i18next-LICENSE'), { force: true })
    }
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
