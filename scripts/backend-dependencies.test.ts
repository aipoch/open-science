import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertBackendImports,
  backendDependencyIncludes,
  isElectronPackage,
  isBackendRuntimeDependency,
  isShippableDependencyPath,
  prismaEngineFilenames
} from './backend-dependencies.mjs'

describe('standalone dependency boundary', () => {
  it('ships query engines for the release platform without development migration engines', () => {
    expect(prismaEngineFilenames('darwin', 'arm64')).toEqual([
      'libquery_engine-darwin-arm64.dylib.node'
    ])
    expect(prismaEngineFilenames('darwin', 'x64')).toEqual(['libquery_engine-darwin.dylib.node'])
    expect(prismaEngineFilenames('linux', 'arm64')).toEqual([
      'libquery_engine-linux-arm64-openssl-3.0.x.so.node'
    ])
    expect(prismaEngineFilenames('linux', 'x64')).toEqual([
      'libquery_engine-debian-openssl-3.0.x.so.node',
      'libquery_engine-rhel-openssl-3.0.x.so.node'
    ])
    expect(prismaEngineFilenames('win32', 'x64')).toEqual(['query_engine-windows.dll.node'])
    expect(() => prismaEngineFilenames('unsupported', 'x64')).toThrow('Unsupported')
    expect(() => prismaEngineFilenames('linux', 'arm')).toThrow('Unsupported')
    expect(() => prismaEngineFilenames('win32', 'arm64')).toThrow('Unsupported')
  })
  it.each([
    'electron',
    'electron/main',
    'electron-updater',
    '@electron-toolkit/utils',
    '@electron/remote'
  ])('forbids %s in the package closure', (name) => {
    expect(isElectronPackage(name)).toBe(true)
  })
  it('rejects an Electron import in any reachable worker or transitive source', () => {
    expect(() =>
      assertBackendImports(
        [{ inputs: { 'deep/worker.ts': { imports: [{ path: 'electron' }] } }, outputs: {} }],
        {}
      )
    ).toThrow('deep/worker.ts')
  })
  it('rejects a development-only runtime dependency before producing an incomplete package', () => {
    expect(() =>
      assertBackendImports(
        [
          { inputs: {}, outputs: { 'index.cjs': { imports: [{ path: 'saxes', external: true }] } } }
        ],
        {}
      )
    ).toThrow('production: saxes')
    expect(() =>
      assertBackendImports(
        [
          {
            inputs: {},
            outputs: {
              'index.cjs': {
                imports: [
                  { path: 'saxes', external: true },
                  { path: 'node:sqlite', external: true }
                ]
              }
            }
          }
        ],
        { saxes: '6.0.0' }
      )
    ).not.toThrow()
  })
  describe('isShippableDependencyPath', () => {
    it.each([
      'package.json',
      'build/Release/probe.node',
      join('build', 'Release', 'probe.node'),
      'src/index.js'
    ])('ships %s', (path) => {
      expect(isShippableDependencyPath(path)).toBe(true)
    })
    it.each([
      'node_modules',
      join('node_modules', 'left-pad', 'index.js'),
      '.git',
      join('.git', 'HEAD'),
      'build/Release/obj.target',
      join('build', 'Release', 'obj.target', 'probe', 'src', 'probe.o'),
      join('build', 'Release', 'obj.target')
    ])('excludes %s', (path) => {
      expect(isShippableDependencyPath(path)).toBe(false)
    })
  })
})

const pdfManifest = JSON.parse(readFileSync('packages/pdf-structure/package.json', 'utf8'))
it.each(['/', '\\'])('stages the PDF npm runtime without source fixtures (%s)', (separator) => {
  for (const path of [
    'dist/index.js',
    'dist/result.d.ts',
    'resources/host.mjs',
    'package.json',
    'LICENSE',
    'README.md'
  ])
    expect(backendDependencyIncludes(pdfManifest, path.split('/').join(separator))).toBe(true)
  for (const path of [
    'src/engine.ts',
    'test/fixtures/case.jsonl',
    'node_modules/sharp/index.js',
    '.git/config',
    'resources/obj.target/worker.o',
    'tsconfig.json'
  ])
    expect(backendDependencyIncludes(pdfManifest, path.split('/').join(separator))).toBe(false)
  expect(backendDependencyIncludes(pdfManifest, '')).toBe(true)
})

it.each(['/', '\\'])(
  'keeps native build intermediates out of the staged dependency closure (%s)',
  (separator) => {
    const manifest = { name: 'native-addon' }
    expect(
      backendDependencyIncludes(
        manifest,
        ['build', 'Release', 'obj.target', 'addon.o'].join(separator)
      )
    ).toBe(false)
    expect(
      backendDependencyIncludes(manifest, ['build', 'Release', 'addon.node'].join(separator))
    ).toBe(true)
  }
)

it.each([
  'compute',
  'connector-builtins',
  'connector-core',
  'connector-mcp-client',
  'diagnostics',
  'durable-files',
  'environment',
  'notebook-analysis',
  'notebook-code-risk',
  'notebook-syntax',
  'literature-citations',
  'literature-discovery',
  'literature-screening',
  'journal-catalog',
  'reproducibility',
  'skills'
])('stages %s using its npm files boundary', (name) => {
  const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'))
  for (const separator of ['/', '\\']) {
    for (const file of [
      '',
      'dist/index.js',
      'package.json',
      'LICENSE',
      ...manifest.files.flatMap((path: string) => [path, `${path}/runtime.wasm`])
    ])
      expect(backendDependencyIncludes(manifest, file.replaceAll('/', separator)), file).toBe(true)
    for (const file of [
      'src/index.ts',
      'test/packed-runtime.mjs',
      '.cache/build.json',
      'tsconfig.json'
    ])
      expect(backendDependencyIncludes(manifest, file.replaceAll('/', separator)), file).toBe(false)
  }
})

it.each(['/', '\\'])('retains reproduction exports and comparison worker (%s)', (separator) => {
  const manifest = JSON.parse(readFileSync('packages/reproducibility/package.json', 'utf8'))
  const exports = Object.values(manifest.exports).flatMap((entry) =>
    Object.values(entry as Record<string, string>)
  )
  for (const file of [...exports, './dist/output-comparison-worker.js'])
    expect(
      backendDependencyIncludes(manifest, file.slice(2).replaceAll('/', separator)),
      file
    ).toBe(true)
})

it.each(['/', '\\'])(
  'omits optional ONNX GPU providers but retains native loading (%s)',
  (separator) => {
    const includes = (file: string): boolean =>
      backendDependencyIncludes(
        { name: 'onnxruntime-node' },
        `bin/napi-v6/linux/x64/${file}`.replaceAll('/', separator),
        { platform: 'linux', arch: 'x64' }
      )
    for (const file of ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so'])
      expect(includes(file), file).toBe(false)
    for (const file of [
      'onnxruntime_binding.node',
      'libonnxruntime.so.1',
      'libonnxruntime_providers_shared.so'
    ])
      expect(includes(file), file).toBe(true)
  }
)

it('retains ONNX JavaScript exports while omitting parallel development bundles', () => {
  const manifest = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8'))
  const paths = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Object.values(value as object).flatMap(paths)
  for (const separator of ['/', '\\']) {
    for (const entry of paths(manifest.exports).filter((path) => /\.m?js$/.test(path))) {
      // Alternate WASM glue is already excluded by the CPU-WASM packaging policy.
      if (/ort-wasm-simd-threaded\.(?:jsep|jspi|asyncify)\./.test(entry)) continue
      expect(
        backendDependencyIncludes(manifest, entry.slice(2).replaceAll('/', separator)),
        entry
      ).toBe(true)
    }
    for (const file of ['ort.js', 'ort.mjs', 'ort.all.js', 'ort.webgl.mjs', 'ort.wasm.js'])
      expect(
        backendDependencyIncludes(manifest, `dist/${file}`.replaceAll('/', separator)),
        file
      ).toBe(false)
  }
})

it.each(['darwin', 'linux', 'win32'] as const)(
  'ships only target ONNX binaries for %s',
  (platform) => {
    for (const arch of ['arm64', 'x64']) {
      for (const separator of ['/', '\\']) {
        const includes = (path: string): boolean =>
          backendDependencyIncludes({ name: 'onnxruntime-node' }, path.replaceAll('/', separator), {
            platform,
            arch
          })
        for (const path of ['', 'bin', 'bin/napi-v6', `bin/napi-v6/${platform}`, 'dist/binding.js'])
          expect(includes(path), path).toBe(true)
        for (const os of ['darwin', 'linux', 'win32']) {
          for (const cpu of ['arm64', 'x64']) {
            const path = `bin/napi-v6/${os}/${cpu}`
            expect(includes(path), path).toBe(os === platform && cpu === arch)
            expect(includes(`${path}/onnxruntime_binding.node`), path).toBe(
              os === platform && cpu === arch
            )
          }
        }
      }
    }
  }
)

it('applies existing desktop asset exclusions to the standalone copy', () => {
  for (const name of [
    '@huggingface/transformers',
    'onnxruntime-node',
    'onnxruntime-web',
    'onnxruntime-common',
    'pdfjs-dist'
  ]) {
    expect(backendDependencyIncludes({ name }, 'dist/runtime.js.map')).toBe(false)
    expect(backendDependencyIncludes({ name }, 'LICENSE')).toBe(true)
  }
  for (const path of [
    'build/pdf.mjs',
    'web/pdf_viewer.mjs',
    'image_decoders/pdf.image_decoders.mjs',
    'types/src/pdf.d.ts'
  ])
    expect(backendDependencyIncludes({ name: 'pdfjs-dist' }, path)).toBe(false)
  for (const path of [
    'legacy/build/pdf.mjs',
    'cmaps/Adobe-Japan1-UCS2.bcmap',
    'standard_fonts/FoxitSans.pfb'
  ])
    expect(backendDependencyIncludes({ name: 'pdfjs-dist' }, path)).toBe(true)
  expect(
    backendDependencyIncludes({ name: 'onnxruntime-web' }, 'dist/ort-wasm-simd-threaded.wasm')
  ).toBe(true)
  expect(backendDependencyIncludes({ name: 'unrelated-package' }, 'dist/runtime.js.map')).toBe(true)
})

it('omits bundled Claude executables and Prisma build-time peers without dropping runtime peers', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64-musl', 'win32-x64'])
    expect(
      isBackendRuntimeDependency(
        `@anthropic-ai/claude-agent-sdk-${target}`,
        '@anthropic-ai/claude-agent-sdk'
      )
    ).toBe(false)
  for (const name of ['prisma', 'typescript']) {
    expect(isBackendRuntimeDependency(name, '@prisma/client')).toBe(false)
    expect(isBackendRuntimeDependency(name, 'unrelated-package')).toBe(true)
  }
  expect(isBackendRuntimeDependency('typescript', 'i18next')).toBe(false)
  for (const name of [
    '@anthropic-ai/claude-agent-sdk',
    '@prisma/client',
    'onnxruntime-node',
    'zod'
  ])
    expect(isBackendRuntimeDependency(name, 'runtime-package')).toBe(true)
})

it('keeps the native Prisma, CPU WASM and selected tokenizer runtime assets', () => {
  for (const [name, removed, retained] of [
    ['@prisma/client', 'runtime/query_engine_bg.sqlite.wasm-base64.js', 'runtime/library.js'],
    ['@prisma/client', 'runtime/query_compiler_bg.mysql.wasm-base64.mjs', 'index.js'],
    [
      'onnxruntime-web',
      'dist/ort-wasm-simd-threaded.jsep.wasm',
      'dist/ort-wasm-simd-threaded.wasm'
    ],
    ['onnxruntime-web', 'dist/ort-wasm-simd-threaded.jspi.wasm', 'dist/ort.wasm.bundle.min.mjs'],
    [
      'onnxruntime-web',
      'dist/ort-wasm-simd-threaded.asyncify.wasm',
      'dist/ort.webgpu.bundle.min.mjs'
    ],
    ['tiktoken', 'encoders/o200k_base.json', 'tiktoken_bg.wasm'],
    ['js-tiktoken', 'dist/index.cjs', 'dist/lite.cjs'],
    ['js-tiktoken', 'dist/ranks/cl100k_base.cjs', 'dist/ranks/o200k_base.cjs']
  ]) {
    for (const separator of ['/', String.fromCharCode(92)]) {
      expect(backendDependencyIncludes({ name }, removed.replaceAll('/', separator))).toBe(false)
      expect(backendDependencyIncludes({ name }, retained.replaceAll('/', separator))).toBe(true)
    }
  }
})
