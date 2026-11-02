/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const OCR_LANGUAGE_CODES = [
  'eng',
  'chi_sim',
  'chi_tra',
  'deu',
  'spa',
  'fra',
  'jpn',
  'kor',
  'rus'
]
export async function buildOcr(output = join(root, 'out/ocr')) {
  await mkdir(output, { recursive: true })
  const banner =
    "import {createRequire as __ocrCreateRequire} from 'node:module'; import {fileURLToPath as __ocrFileURLToPath} from 'node:url'; import {dirname as __ocrDirname} from 'node:path'; const require=__ocrCreateRequire(import.meta.url); const __filename=__ocrFileURLToPath(import.meta.url); const __dirname=__ocrDirname(__filename);"
  const graphs = []
  for (const [file, entry] of [
    ['ocr-worker.mjs', 'scripts/ocr/worker.mjs'],
    ['ocr-engine.mjs', 'node_modules/tesseract.js/src/worker-script/node/index.js']
  ]) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [join(root, entry)],
      outfile: join(output, file),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      metafile: true,
      banner: { js: banner },
      logLevel: 'silent',
      plugins: [
        {
          name: 'node-fetch',
          setup(plugin) {
            plugin.onResolve({ filter: /^node-fetch$/ }, () => ({
              path: 'node-fetch',
              namespace: 'ocr-node-fetch'
            }))
            plugin.onLoad({ filter: /.*/, namespace: 'ocr-node-fetch' }, () => ({
              contents: 'module.exports = (...args) => globalThis.fetch(...args)'
            }))
          }
        }
      ]
    })
    for (const item of Object.values(result.metafile.outputs).flatMap((value) => value.imports))
      if (item.external && !builtinModules.includes(item.path) && !item.path.startsWith('node:'))
        throw new Error(`Unexpected OCR runtime dependency: ${item.path}`)
    graphs.push(result.metafile)
  }
  const upstream = new Map()
  for (const file of (await readdir(join(root, 'node_modules/tesseract.js-core'))).filter((name) =>
    name.endsWith('.wasm')
  )) {
    await copyFile(join(root, 'node_modules/tesseract.js-core', file), join(output, file))
    upstream.set(file, `https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/${file}`)
  }
  for (const code of OCR_LANGUAGE_CODES) {
    const file = `${code}.traineddata.gz`
    await copyFile(
      join(root, `node_modules/@tesseract.js-data/${code}/4.0.0_best_int/${file}`),
      join(output, file)
    )
    upstream.set(
      file,
      `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}@1.0.0/4.0.0_best_int/${file}`
    )
  }
  const packages = new Set(
    graphs.flatMap((graph) =>
      Object.keys(graph.inputs).flatMap((name) => {
        const match = name.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)
        return match ? [match[1]] : []
      })
    )
  )
  for (const code of OCR_LANGUAGE_CODES) packages.add(`node_modules/@tesseract.js-data/${code}`)
  let notices = 'Open-Science optional PDF OCR component — third-party notices\n'
  for (const directory of [...packages].sort()) {
    const path = join(root, directory)
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    notices += `\n===== ${pkg.name}@${pkg.version} (${pkg.license}) =====\n`
    for (const file of (await readdir(path)).sort())
      if (/^(license|copying|notice)/i.test(file) && (await stat(join(path, file))).isFile())
        notices += '\n' + (await readFile(join(path, file), 'utf8'))
  }
  await writeFile(join(output, 'licenses.txt'), notices)
  // First-party URLs are publication targets; a local build does not publish these files.
  const assets = []
  for (const file of [
    'ocr-worker.mjs',
    'ocr-engine.mjs',
    'licenses.txt',
    ...upstream.keys()
  ].sort()) {
    const data = await readFile(join(output, file))
    const sha256 = createHash('sha256').update(data).digest('hex')
    assets.push({
      file,
      url: upstream.get(file) ?? `https://statics.aipoch.com/open-science/ocr/${sha256}/${file}`,
      size: data.length,
      sha256
    })
  }
  const revision = `ocr-${createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16)}`
  const catalog = { revision, assets }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(catalog, null, 2) + '\n')
  return catalog
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = await buildOcr()
  if (process.argv.includes('--catalog')) {
    const path = join(root, 'src/main/local-models/catalog.ts')
    const existing = (await readFile(path, 'utf8')).split('\n// Generated by npm run build:ocr')[0]
    const languagePacks = Object.fromEntries(
      OCR_LANGUAGE_CODES.map((code) => [
        code,
        {
          revision: `ocr-language-${code.replaceAll('_', '-')}-v1`,
          assets: [catalog.assets.find((asset) => asset.file === `${code}.traineddata.gz`)]
        }
      ])
    )
    const runtimeAssets = catalog.assets.filter((asset) => !asset.file.endsWith('.traineddata.gz'))
    const runtimeCatalog = {
      revision: `ocr-runtime-${createHash('sha256').update(JSON.stringify(runtimeAssets)).digest('hex').slice(0, 16)}`,
      assets: runtimeAssets
    }
    const legacyRuntimeCatalog = {
      revision: 'ocr-7ed9791930e614a1',
      assets: [
        {
          file: 'chi_sim.traineddata.gz',
          url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz',
          size: 1718768,
          sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c'
        },
        {
          file: 'eng.traineddata.gz',
          url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
          size: 2952873,
          sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
        },
        {
          file: 'licenses.txt',
          url: 'https://statics.aipoch.com/open-science/ocr/6702c6b73e37c34c9db7342b2964ff513a8162b086733bd0fd03cda90df4896d/licenses.txt',
          size: 37677,
          sha256: '6702c6b73e37c34c9db7342b2964ff513a8162b086733bd0fd03cda90df4896d'
        },
        {
          file: 'ocr-engine.mjs',
          url: 'https://statics.aipoch.com/open-science/ocr/f8831b545ef7136c6bb8247406ce2ca93d88ecf37e801716f08ed9c1389d5032/ocr-engine.mjs',
          size: 525077,
          sha256: 'f8831b545ef7136c6bb8247406ce2ca93d88ecf37e801716f08ed9c1389d5032'
        },
        {
          file: 'ocr-worker.mjs',
          url: 'https://statics.aipoch.com/open-science/ocr/26269fa529d48a0f249f2ecf16137fd156f0ee1a0e94470fc3f03023046a7be9/ocr-worker.mjs',
          size: 16396,
          sha256: '26269fa529d48a0f249f2ecf16137fd156f0ee1a0e94470fc3f03023046a7be9'
        },
        {
          file: 'tesseract-core-lstm.wasm',
          url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-lstm.wasm',
          size: 2871085,
          sha256: '220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b'
        },
        {
          file: 'tesseract-core-simd-lstm.wasm',
          url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd-lstm.wasm',
          size: 2871377,
          sha256: '187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d'
        },
        {
          file: 'tesseract-core-simd.wasm',
          url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd.wasm',
          size: 3469078,
          sha256: 'ca11ee92a02023e4f5083eefd0966fb83b297416da54e997b9f6ce445f719c9b'
        },
        {
          file: 'tesseract-core.wasm',
          url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core.wasm',
          size: 3468788,
          sha256: '740f7e466a2f026e1f1e54a2e0d9957e386d8166110d1290224abd3d08986106'
        }
      ]
    }
    const chineseFirstLegacyCatalog = {
      ...legacyRuntimeCatalog,
      revision: 'ocr-74bc858287ce927b',
      assets: legacyRuntimeCatalog.assets.map((asset) =>
        asset.file === 'ocr-worker.mjs'
          ? {
              ...asset,
              url: 'https://statics.aipoch.com/open-science/ocr/22eb6f96c4bcf86d276ee02768db1eb3b8da7ecc80550f10ae67ba5d03c82487/ocr-worker.mjs',
              sha256: '22eb6f96c4bcf86d276ee02768db1eb3b8da7ecc80550f10ae67ba5d03c82487'
            }
          : asset
      )
    }
    const { format, resolveConfig } = await import('prettier')
    await writeFile(
      path,
      await format(
        existing +
          '\n// Generated by npm run build:ocr -- --catalog. Publish first-party assets before release.\nexport const OCR_MODEL_REVISIONS: readonly LocalModelRevision[] = ' +
          JSON.stringify([catalog]) +
          '\nexport const OCR_RUNTIME_REVISIONS: readonly LocalModelRevision[] = ' +
          JSON.stringify([runtimeCatalog, chineseFirstLegacyCatalog, legacyRuntimeCatalog]) +
          '\nexport const OCR_LANGUAGE_PACK_REVISIONS: Readonly<Record<string, LocalModelRevision>> = ' +
          JSON.stringify(languagePacks),
        { ...(await resolveConfig(path)), parser: 'typescript' }
      )
    )
  }
  console.log(
    JSON.stringify({
      revision: catalog.revision,
      bytes: catalog.assets.reduce((total, asset) => total + asset.size, 0)
    })
  )
}
