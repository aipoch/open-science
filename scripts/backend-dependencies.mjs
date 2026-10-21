/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { builtinModules } from 'node:module'
import { posix } from 'node:path'

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

// These renderer imports are already compiled into out/web. Only omit their direct backend
// roots: the dependency walker must still retain them if another runtime package needs them.
export function desktopBackendDependencies(dependencies, metafiles) {
  assertBackendImports(metafiles, dependencies)
  const bundled = desktopBundledDependencies(metafiles)
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

// Use the actual build graph, never an assumed build mode, to remove a runtime root.
// A mixed bundled/external copy would create independent module instances in one process.
export function desktopBundledDependencies(metafiles) {
  const bundled = new Set()
  if (
    metafiles.some((meta) =>
      Object.keys(meta.inputs).some((path) => /(?:^|[\\/])node_modules[\\/]i18next[\\/]/.test(path))
    )
  ) {
    for (const meta of metafiles)
      for (const output of Object.values(meta.outputs))
        if (output.imports.some((item) => item.external && packageName(item.path) === 'i18next'))
          throw new Error('Desktop backend cannot mix bundled and external i18next.')
    bundled.add('i18next')
  }
  return bundled
}

// Agent SDK 0.3.232 refers to the API SDK only from its .d.ts files. Desktop consumers
// execute the prebuilt JavaScript; standalone/SDK staging retains the published type contract.
// Keep unknown versions and every other incoming edge until separately audited.
export function desktopBackendPeerDependencies(manifest) {
  return Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) =>
      !(
        manifest.name === '@anthropic-ai/claude-agent-sdk' &&
        manifest.version === '0.3.232' &&
        name === '@anthropic-ai/sdk'
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
  const runtimeEntries = []
  const collect = (value) => {
    if (typeof value === 'string') runtimeEntries.push(value.replace(/^\.\//, ''))
    else if (value && typeof value === 'object')
      for (const [key, entry] of Object.entries(value))
        if (key !== 'types' && !key.startsWith('types@')) collect(entry)
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
  return (relativePath, isDirectory) => {
    // Traverse excluded roots so nested redistribution notices are not lost. Keep first-party
    // artifacts, SDK declarations and diagnostic maps under their existing files allowlists.
    if (isDirectory || manifest.name?.startsWith('@aipoch/')) return true
    const parts = relativePath.split(/[\\/]/)
    const path = parts.join('/')
    if (parts.some((part) => /^(?:licen[cs]es?|notices?|copying|copyright)(?:[._-]|$)/i.test(part)))
      return true
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
export function backendDependencyIncludes(
  manifest,
  relativePath,
  { platform = process.platform, arch = process.arch } = {}
) {
  const parts = relativePath.split(/[\\/]/)
  const top = parts[0]
  if (!isShippableDependencyPath(relativePath)) return false
  const name = manifest.name
  if (
    [
      'pdfjs-dist',
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-common',
      'onnxruntime-web',
      '@prisma/client',
      'pdf-lib'
    ].includes(name) &&
    relativePath.endsWith('.map')
  )
    return false
  // This generated client uses the native library engine, not WASM query engines/compilers.
  if (name === '@prisma/client' && /^runtime[\\/]query_(?:engine|compiler)_bg\./.test(relativePath))
    return false
  // Local inference explicitly selects CPU WASM; WebGPU/JSPI/Asyncify binaries are unused.
  if (
    name === 'onnxruntime-web' &&
    /^dist[\\/]ort-wasm-simd-threaded\.(?:jsep|jspi|asyncify)\.(?:mjs|wasm)$/.test(relativePath)
  )
    return false
  // Package exports use the minified builds; these parallel development bundles are never loaded.
  if (
    name === 'onnxruntime-web' &&
    /^dist[\\/]ort(?:\.(?:all|wasm|webgl|webgpu|jspi|node))?\.(?:mjs|js)$/.test(relativePath)
  )
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
  // Transformers imports the target native binding even when inference explicitly selects WASM.
  if (name === 'onnxruntime-node' && top === 'bin' && parts[1] === 'napi-v6') {
    if (parts[2] && parts[2] !== platform) return false
    if (parts[3] && parts[3] !== arch) return false
    // Linux npm installs download optional GPU providers; local translation selects WASM.
    if (/^libonnxruntime_providers_(?:cuda|tensorrt)\.so$/.test(parts[4] ?? '')) return false
  }
  if (
    ![
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
