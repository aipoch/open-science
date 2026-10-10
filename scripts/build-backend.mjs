/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { assertBackendImports } from './backend-dependencies.mjs'
import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { wsl2BuildDefines } from './wsl2-build-flags.mjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'out/backend')
await mkdir(out, { recursive: true })
const workers = new Map()
const metadata = []
const buildEntry = async (entry, outfile) => {
  const result = await build({
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
      ...wsl2BuildDefines(process.platform, process.argv.includes('--development'), process.env)
    },
    banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [
      {
        name: 'open-science-node-resources',
        setup(plugin) {
          plugin.onResolve({ filter: /^@aipoch\/notebook-network-sandbox$/ }, () => ({
            path: join(root, 'packages/notebook-network-sandbox/src/index.ts')
          }))
          plugin.onResolve({ filter: /\?nodeWorker$/ }, ({ path, resolveDir }) => ({
            path: resolve(resolveDir, path.slice(0, -11) + '.ts'),
            namespace: 'node-worker'
          }))
          plugin.onLoad({ filter: /.*/, namespace: 'node-worker' }, ({ path }) => {
            const name = `${basename(path, '.ts')}-${createHash('sha256').update(path.slice(root.length)).digest('hex').slice(0, 10)}.cjs`
            workers.set(path, name)
            return {
              contents: `import { Worker } from 'node:worker_threads'; import { join } from 'node:path'; export default (options) => new Worker(join(__dirname, ${JSON.stringify(name)}), options);`,
              loader: 'js'
            }
          })
          plugin.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({
            path: resolve(resolveDir, path.slice(0, -4)),
            namespace: 'raw-resource'
          }))
          plugin.onLoad({ filter: /.*/, namespace: 'raw-resource' }, async ({ path }) => ({
            contents: await readFile(path, 'utf8'),
            loader: 'text'
          }))
        }
      }
    ]
  })
  metadata.push(result.metafile)
}
await buildEntry(join(root, 'src/main/node-entry.ts'), join(out, 'index.cjs'))
for (const [entry, name] of workers) await buildEntry(entry, join(out, name))
assertBackendImports(
  metadata,
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies
)
await mkdir(join(out, 'native-locales'), { recursive: true })
for (const file of await readdir(join(root, 'src/shared/i18n/locales'))) {
  if (!file.endsWith('.json')) continue
  const { common, native } = JSON.parse(
    await readFile(join(root, 'src/shared/i18n/locales', file), 'utf8')
  )
  await writeFile(join(out, 'native-locales', file), JSON.stringify({ common, native }))
}
await writeFile(join(out, 'dependencies.json'), JSON.stringify(metadata, null, 2))
console.log(`Built Node backend and ${workers.size} workers without Electron imports.`)
