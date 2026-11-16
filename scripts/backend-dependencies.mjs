/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { builtinModules } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative as relativePath } from 'node:path'

// Standard inline maps keep diagnostics while avoiding a second installed file per module.
// Only rewrite audited desktop copies, retaining every executable byte and map byte.
export async function inlineDesktopDependencyMaps(manifest, directory) {
  const versions = {
    '@modelcontextprotocol/sdk': '1.31.0',
    ajv: '8.20.0',
    tar: '7.5.22',
    '@agentclientprotocol/sdk': '1.3.0'
  }
  if (!Object.hasOwn(versions, manifest.name) || versions[manifest.name] !== manifest.version)
    return 0
  let count = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') count += await inlineDesktopDependencyMaps(manifest, file)
      continue
    }
    if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
    const code = await readFile(file, 'utf8')
    const match = code.match(/\/\/# sourceMappingURL=([^\s]+)(\r?\n)?$/)
    if (!match || match[1] !== `${entry.name}.map`) continue
    const mapFile = `${file}.map`
    const map = await readFile(mapFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!map) continue
    let parsed
    try {
      parsed = JSON.parse(map.toString('utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      continue
    }
    // Indexed maps can contain relative map URLs whose base would change in a data URL.
    if (parsed?.version !== 3 || !Array.isArray(parsed.sources) || parsed.sections) continue
    const replacement = match[0].replace(
      match[1],
      `data:application/json;base64,${map.toString('base64')}`
    )
    await writeFile(file, code.slice(0, match.index) + replacement)
    await unlink(mapFile)
    count++
  }
  return count
}

export const isElectronPackage = (name) =>
  /^(?:electron(?:$|\/|-)|@electron(?:-toolkit)?\/)/.test(name)

// Claude always uses the detected executable; Prisma's optional peers generate clients at build time.
export const isBackendRuntimeDependency = (name, parentName) =>
  !name.startsWith('@anthropic-ai/claude-agent-sdk-') &&
  !(parentName === '@prisma/client' && ['prisma', 'typescript'].includes(name)) &&
  !(parentName === 'i18next' && name === 'typescript')

// Match Release's engine policy, including both supported Linux x64 OpenSSL 3 distributions.
export const prismaEngineFilenames = (platform = process.platform, arch = process.arch) => {
  if (!['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64'))
    throw new Error(`Unsupported Prisma runtime platform: ${platform}/${arch}`)
  if (platform === 'darwin')
    return [`libquery_engine-darwin${arch === 'arm64' ? '-arm64' : ''}.dylib.node`]
  if (platform === 'win32') return ['query_engine-windows.dll.node']
  if (platform === 'linux')
    return arch === 'arm64'
      ? ['libquery_engine-linux-arm64-openssl-3.0.x.so.node']
      : [
          'libquery_engine-debian-openssl-3.0.x.so.node',
          'libquery_engine-rhel-openssl-3.0.x.so.node'
        ]
  throw new Error(`Unsupported Prisma runtime platform: ${platform}/${arch}`)
}
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

// Called only after staging verifies the generated client uses the native library engine.
export function generatedPrismaIncludes(relativePath, { desktop = false, ...target } = {}) {
  const file = relativePath.replaceAll('\\', '/')
  if (file === 'query_engine_bg.wasm') return false
  if (desktop && /\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(file)) return false
  return (
    !file.includes('query_engine-') ||
    prismaEngineFilenames(target.platform, target.arch).includes(file)
  )
}

// These renderer imports are already compiled into out/web. Only omit their direct backend
// roots: the dependency walker must still retain them if another runtime package needs them.
export function desktopBackendDependencies(dependencies, metafiles, allowed = new Set(), root) {
  assertBackendImports(metafiles, dependencies, allowed)
  const bundled = desktopBundledDependencies(metafiles, undefined, root)
  const rendererRoots = new Set([
    '@radix-ui/react-focus-scope',
    '@rc-component/qrcode',
    'react-markdown',
    'react-remove-scroll',
    'tiff'
  ])
  const runtimeImports = new Set(
    metafiles.flatMap((meta) =>
      Object.values(meta.outputs).flatMap((output) =>
        output.imports.filter((item) => item.external).map((item) => packageName(item.path))
      )
    )
  )
  return Object.keys(dependencies).filter(
    (name) => !bundled.has(name) && (!rendererRoots.has(name) || runtimeImports.has(name))
  )
}

// Packages that must stay on disk: they ship native code or runtime assets, or the backend
// locates them by path for another process. Everything else is bundled. The closure is
// computed so a package that stays on disk never depends on one that was bundled.
const desktopExternalRoots = [
  // Connector providers are resolved by subpath at runtime, so esbuild cannot record these
  // dynamic requires in its external import graph. Keep the published package staged.
  '@aipoch/connector-builtins',
  'pdfjs-dist',
  '@bokuweb/zstd-wasm',
  'tiktoken',
  '@aipoch/notebook-syntax',
  'web-tree-sitter',
  '@embedpdf/pdfium',
  'tesseract.js',
  'tesseract.js-core',
  '@aipoch/process-tree-native',
  'citeme-engine-wasm',
  'sharp',
  '@aipoch/safe-file-publisher-native',
  '@napi-rs/canvas',
  '@aipoch/credential-identity-probe-native',
  '@prisma/client',
  '@agentclientprotocol/claude-agent-acp',
  '@anthropic-ai/claude-agent-sdk',
  '@aipoch/literature-citations',
  '@aipoch/pdf-translation',
  '@aipoch/pdf-structure',
  '@aipoch/research-film',
  'tslib'
]

export const desktopExternalClosure = (root) => {
  const external = new Set()
  const locate = (name, from) => {
    let directory = from
    while (true) {
      const candidate = join(directory, 'node_modules', name, 'package.json')
      if (existsSync(candidate)) return candidate
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
  const visit = (name, from, optional) => {
    if (external.has(name) || builtinModules.includes(name)) return
    const manifestPath = locate(name, from)
    if (!manifestPath) {
      if (optional) return
      throw new Error('Missing external dependency: ' + name)
    }
    external.add(name)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const directory = dirname(manifestPath)
    const optionalDependencies = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta?.optional)
        .map(([name]) => name)
    ])
    for (const dependency of new Set([
      ...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }),
      ...desktopBackendPeerDependencies(manifest)
    ]))
      visit(dependency, directory, optionalDependencies.has(dependency))
  }
  // A root that is not installed has no files to keep; its own missing dependencies still fail.
  for (const name of desktopExternalRoots) visit(name, root, true)
  return external
}

// Use the actual build graph, never an assumed build mode, to remove a runtime root.
// A mixed bundled/external copy would create independent module instances in one process.
export function desktopBundledDependencies(metafiles, external = new Set(), root) {
  const bundled = new Set()
  for (const meta of metafiles)
    for (const path of Object.keys(meta.inputs)) {
      const match = /(?:^|[\\/])node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(path)
      if (match) bundled.add(match[1].replaceAll('\\', '/'))
      // Workspace packages resolve through their real path, without a node_modules segment.
      const local = root && !match && /^packages[\\/]([^\\/]+)[\\/]/.exec(path)
      if (local) {
        const manifest = join(root, 'packages', local[1], 'package.json')
        if (existsSync(manifest)) bundled.add(JSON.parse(readFileSync(manifest, 'utf8')).name)
      }
    }
  for (const name of bundled) {
    if (external.has(name))
      throw new Error('Desktop backend cannot bundle the external dependency ' + name + '.')
    for (const meta of metafiles)
      for (const output of Object.values(meta.outputs))
        if (
          output.imports.some(
            (item) =>
              item.external &&
              !item.path.startsWith('node:') &&
              !builtinModules.includes(item.path) &&
              packageName(item.path) === name
          )
        )
          throw new Error('Desktop backend cannot mix bundled and external ' + name + '.')
  }
  return bundled
}

// Agent SDK 0.3.232 refers to the API and MCP SDKs only from its .d.ts files; its runtime
// JavaScript inlines what it needs. Desktop consumers execute the prebuilt JavaScript, so these
// edges must not keep the MCP SDK external, which would leave its server stack on disk.
// Standalone/SDK staging retains the published type contract. Keep unknown versions and every
// other incoming edge until separately audited.
export function desktopBackendPeerDependencies(manifest) {
  return Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) =>
      !(
        manifest.name === '@anthropic-ai/claude-agent-sdk' &&
        manifest.version === '0.3.232' &&
        ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk'].includes(name)
      )
  )
}

// node-gyp keeps compiler intermediates (e.g. *.o) in build/Release/obj.target. They are dead
// weight at runtime and, being unsigned Mach-O objects, break packaged signature verification —
// so dependency copies for the standalone backend must never include them.
export const isShippableDependencyPath = (relativePath) => {
  const parts = relativePath.split(/[\\/]/)
  return parts[0] !== 'node_modules' && parts[0] !== '.git' && !parts.includes('obj.target')
}

// extraResources bypasses electron-builder's NodeModuleCopyHelper exclusions. Apply a
// conservative subset to desktop dependencies only; npm/SDK staging keeps its type contract.
// See https://www.electron.build/v26/docs/contents/ and VS Code's build/.moduleignore.
export function createDesktopDependencyFilter(manifest) {
  // These alternate distributions have no consumers in the packaged application. Keep the
  // npm/SDK closure intact, and re-audit whenever an upstream package version changes.
  const unusedDistributions = {
    'openchemlib@9.25.0': /^dist\/openchemlib\.debug\.js(?:\.map)?$/,
    'web-tree-sitter@0.26.13': /^debug\/web-tree-sitter\.(?:js|cjs|wasm)(?:\.map)?$/,
    'styled-exceljs@0.21.6':
      /^dist\/xlsx\.(?:extendscript|(?:full|core|mini)\.min)\.(?:js(?:\.map)?|map)$/,
    '@embedpdf/pdfium@2.15.1': /^dist\/index\.browser\.js(?:\.map)?$/,
    'pako@0.2.9': /^dist\/[^/]+\.js(?:\.map)?$/,
    'pako@1.0.11': /^dist\/[^/]+\.js(?:\.map)?$/
  }[`${manifest.name}@${manifest.version}`]
  const zod = manifest.name === 'zod' && ['4.6.5', '4.6.7'].includes(manifest.version)
  const runtimeEntries = []
  const collect = (value) => {
    if (typeof value === 'string') runtimeEntries.push(value.replace(/^\.\//, ''))
    else if (value && typeof value === 'object')
      for (const [key, entry] of Object.entries(value))
        if (key !== 'types' && !key.startsWith('types@') && !(zod && key === '@zod/source'))
          collect(entry)
  }
  for (const field of ['main', 'module', 'bin', 'exports', 'imports', 'browser'])
    collect(manifest[field])
  const exportedRoots = new Set(runtimeEntries.map((entry) => entry.split('/')[0]))
  const developmentRoots = new Set([
    'test',
    'tests',
    '__tests__',
    'powered-test',
    'example',
    'examples'
  ])
  if (zod) developmentRoots.add('src')
  for (const [name, version, directory] of [
    ['ajv', '8.20.0', 'lib'],
    ['entities', '6.0.1', 'src']
  ])
    if (manifest.name === name && manifest.version === version) developmentRoots.add(directory)
  return (relativePath, isDirectory) => {
    // Traverse excluded roots so nested redistribution notices are not lost. Keep first-party
    // artifacts, SDK declarations and diagnostic maps under their existing files allowlists.
    if (isDirectory || manifest.name?.startsWith('@aipoch/')) return true
    const parts = relativePath.split(/[\\/]/)
    const path = parts.join('/')
    if (parts.some((part) => /^(?:licen[cs]es?|notices?|copying|copyright)(?:[._-]|$)/i.test(part)))
      return true
    if (unusedDistributions?.test(path)) return false
    // Zod's source condition is opt-in development only; its locale wildcard also matches
    // declarations. Neither is used by packaged Node's normal import/require resolution.
    if (zod && /^v4\/locales\/[^/]+\.d\.(?:ts|cts)$/.test(path)) return false
    if (runtimeEntries.some((entry) => posix.matchesGlob(path, entry))) return true
    if (/\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(path)) return false
    return (
      !developmentRoots.has(parts[0]) ||
      [...exportedRoots].some((entry) => posix.matchesGlob(parts[0], entry))
    )
  }
}

// esbuild inputs cover the entire reachable source/worker graph; outputs record actual external
// runtime imports after type erasure. Packaging independently walks every dependency and peer.
export const missingOptionalDependencies = (root, metafiles) => {
  const missing = new Set()
  for (const meta of metafiles)
    for (const path of Object.keys(meta.inputs)) {
      const parts = path.split(/[\\/]/)
      const at = parts.lastIndexOf('node_modules')
      if (at < 0) continue
      const depth = parts[at + 1].startsWith('@') ? 3 : 2
      const manifestPath = join(root, ...parts.slice(0, at + depth), 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const optional = [
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.entries(manifest.peerDependenciesMeta ?? {})
          .filter(([, value]) => value?.optional)
          .map(([name]) => name)
      ]
      for (const name of optional)
        if (!existsSync(join(root, 'node_modules', name, 'package.json'))) missing.add(name)
    }
  return missing
}

// Bundling relocates a module to out/backend, so anything that reads a file relative to its own
// location breaks unless the file moves with it. Fail the build on such code unless the exact file
// has been checked and listed here. Add an entry only after confirming the read is dead, resolves
// through node_modules, or is served by a compiled file worker.
const bundledSelfLocationAllowlist = new Map([
  // registerFromNodejs() is never called; the live import.meta.url is only read if it is.
  ['node_modules/openchemlib/dist/openchemlib.js', 'dead registerFromNodejs branch'],
  // Worker is compiled beside index.cjs, so join(__dirname, name) still resolves.
  ['packages/compute/dist/hugging-face-bucket.js', 'compiled file worker'],
  // createRequire(__filename) walks up to the staged node_modules, where both stay external.
  ['packages/reproducibility/dist/output-comparison.js', 'resolves staged sharp and papaparse']
])

const selfLocationPattern =
  /\b__dirname\b|\b__filename\b|import\.meta\.(?:url|dirname|filename)|require\.resolve\s*\(/

export function assertBundledModulesStayPortable(metafiles, root) {
  const offenders = []
  for (const meta of metafiles)
    for (const path of Object.keys(meta.inputs)) {
      if (path.startsWith('raw-resource:') || path.startsWith('node-worker:')) continue
      const relative = (isAbsolute(path) ? relativePath(root, path) : path).replaceAll('\\', '/')
      if (relative.startsWith('src/')) continue
      if (!selfLocationPattern.test(readFileSync(join(root, relative), 'utf8'))) continue
      if (!bundledSelfLocationAllowlist.has(relative)) offenders.push(relative)
    }
  if (offenders.length)
    throw new Error(
      'Bundled module locates its own files and is not on the allowlist: ' +
        offenders.sort().join(', ') +
        '. Keep the package external, or verify the read and add the file to bundledSelfLocationAllowlist.'
    )
}

export function assertBackendImports(metafiles, dependencies, allowed = new Set()) {
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
        if (!(name in dependencies) && !allowed.has(name))
          throw new Error(`Backend dependency must be declared for production: ${name}`)
      }
    }
  }
}

// Local file: dependencies are symlinks in development. Keep the independent packages' source/fixtures
// out of shipped runtimes, using its deliberately literal top-level npm files allowlist.
export function backendDependencyIncludes(manifest, relativePath) {
  const parts = relativePath.split(/[\\/]/)
  const top = parts[0]
  if (!isShippableDependencyPath(relativePath)) return false
  const name = manifest.name
  // These audited Node entry points never load the parallel browser distributions. The Web UI
  // is built separately before staging; keep both Node import/require entries and their assets.
  const path = parts.join('/')
  // Keep traversing the directories so redistribution notices cannot be hidden by a parent rule.
  if (name === 'pdf-lib' && manifest.version === '1.17.1' && /^dist\/[^/]+\.js$/.test(path))
    return false
  if (
    name === 'fontkit' &&
    manifest.version === '2.0.4' &&
    /^dist\/browser(?:-module\.mjs|\.cjs)(?:\.map)?$/.test(path)
  )
    return false
  if (
    name === '@bokuweb/zstd-wasm' &&
    manifest.version === '0.0.27' &&
    /^dist\/(?:web|esm)\/.*\.(?:js|wasm|map)$/.test(path)
  )
    return false
  if (['pdfjs-dist', '@prisma/client', 'pdf-lib'].includes(name) && relativePath.endsWith('.map'))
    return false
  // This generated client uses the native library engine, not WASM query engines/compilers.
  if (name === '@prisma/client' && /^runtime[\\/]query_(?:engine|compiler)_bg\./.test(relativePath))
    return false
  // The full tokenizer embeds its encodings in WASM; separate JSON/JS encoders belong to lite.
  if (name === 'tiktoken' && top === 'encoders') return false
  // xAI uses only the lightweight tokenizer and o200k_base, not the all-encoding entry point.
  if (name === 'js-tiktoken' && top === 'dist') {
    if (/^index\./.test(parts[1] ?? '')) return false
    if (parts[1] === 'ranks' && parts[2] && !parts[2].startsWith('o200k_base.')) return false
  }
  // Match the existing desktop PDF.js exclusions; extraction still needs legacy/build and font data.
  if (name === 'pdfjs-dist' && ['build', 'web', 'image_decoders', 'types'].includes(top))
    return false
  if (
    ![
      '@aipoch/agent-harness',
      '@aipoch/compute',
      '@aipoch/connector-builtins',
      '@aipoch/connector-core',
      '@aipoch/connector-mcp-client',
      '@aipoch/diagnostics',
      '@aipoch/providers',
      '@aipoch/environment',
      '@aipoch/notebook-analysis',
      '@aipoch/notebook-code-risk',
      '@aipoch/notebook-syntax',
      '@aipoch/pdf-structure',
      '@aipoch/pdf-translation',
      '@aipoch/literature-citations',
      '@aipoch/journal-catalog',
      '@aipoch/literature-discovery',
      '@aipoch/reproducibility',
      '@aipoch/literature-screening',
      '@aipoch/literature-library',
      '@aipoch/literature-reading',
      '@aipoch/durable-files',
      '@aipoch/resilient-download',
      '@aipoch/skills'
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
