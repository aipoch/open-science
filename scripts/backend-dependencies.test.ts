import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertBackendImports,
  backendDependencyIncludes,
  createDesktopDependencyFilter,
  desktopBackendDependencies,
  desktopBackendPeerDependencies,
  desktopBundledDependencies,
  isElectronPackage,
  isBackendRuntimeDependency,
  isShippableDependencyPath,
  prismaEngineFilenames
} from './backend-dependencies.mjs'

describe('desktop-only dependency contents', () => {
  it('rejects an external consumer of bundled i18next in the real staging command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-bundle-consumer-'))
    const put = async (file: string, content: string): Promise<void> => {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), content)
    }
    try {
      for (const file of ['scripts/stage-backend.mjs', 'scripts/backend-dependencies.mjs'])
        await put(file, await readFile(join(process.cwd(), file), 'utf8'))
      await put('package.json', JSON.stringify({ dependencies: { i18next: '1', consumer: '1' } }))
      await put('packages/open-science/package.json', '{}')
      await put('out/backend/dependencies.json', '[]')
      const stage = (): Promise<unknown> =>
        promisify(execFile)(
          process.execPath,
          [join(root, 'scripts/stage-backend.mjs'), '--desktop'],
          { cwd: root, timeout: 10_000 }
        )
      // The old default output must not silently substitute for a missing desktop build.
      await expect(stage()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('desktop-backend-build')
      })
      await put(
        'out/desktop-backend-build/dependencies.json',
        JSON.stringify([
          {
            inputs: { 'node_modules/i18next/dist/cjs/i18next.js': { imports: [] } },
            outputs: { 'index.cjs': { imports: [] } }
          }
        ])
      )
      const platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
      for (const file of [
        'out/web/index.html',
        'LICENSE',
        'packages/open-science/README.md',
        'packages/open-science/CLI.md',
        `resources/bin/${platform}/${process.arch}/micromamba${process.platform === 'win32' ? '.exe' : ''}`,
        ...(process.platform === 'win32'
          ? [
              `resources/bin/win/${process.arch}/micromamba-compat.exe`,
              `packages/notebook-network-sandbox/vendor/windows/${process.arch}/fixture.exe`,
              'packages/notebook-network-sandbox/vendor/wsl2/manifest.json'
            ]
          : [])
      ])
        await put(file, 'synthetic fixture')
      await put(
        'node_modules/consumer/package.json',
        JSON.stringify({ name: 'consumer', version: '1', dependencies: { i18next: '1' } })
      )
      await expect(stage()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('requires bundled i18next')
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['/', '\\'])(
    'omits i18next only after compilation proves it is inlined (%s)',
    (separator) => {
      const dependencies = { i18next: '25.10.10', 'external-package': '1' }
      const metadata = [
        {
          inputs: {
            ['node_modules/i18next/dist/cjs/i18next.js'.replaceAll('/', separator)]: { imports: [] }
          },
          outputs: { 'index.cjs': { imports: [] } }
        }
      ]
      expect([...desktopBundledDependencies(metadata)]).toEqual(['i18next'])
      expect(desktopBackendDependencies(dependencies, metadata)).toEqual(['external-package'])
      expect(desktopBackendDependencies(dependencies, [{ inputs: {}, outputs: {} }])).toEqual(
        Object.keys(dependencies)
      )
      expect(() =>
        desktopBackendDependencies(dependencies, [
          ...metadata,
          {
            inputs: {},
            outputs: { 'worker.cjs': { imports: [{ path: 'i18next', external: true }] } }
          }
        ])
      ).toThrow('cannot mix bundled and external i18next')
    }
  )

  it('omits only the audited type-only peer edge, retaining new versions and other consumers', () => {
    const manifest = {
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.232',
      peerDependencies: { '@anthropic-ai/sdk': '>=0.93.0', zod: '^4.0.0' }
    }
    expect(desktopBackendPeerDependencies(manifest)).toEqual(['zod'])
    for (const other of [
      { ...manifest, version: '0.3.233' },
      { ...manifest, name: 'another-consumer' }
    ])
      expect(desktopBackendPeerDependencies(other)).toEqual(['@anthropic-ai/sdk', 'zod'])
    expect(Object.keys(manifest.peerDependencies)).toEqual(['@anthropic-ai/sdk', 'zod'])
    expect(isBackendRuntimeDependency('@anthropic-ai/sdk', manifest.name)).toBe(true)
    expect(
      desktopBackendDependencies({ '@anthropic-ai/sdk': '1' }, [{ inputs: {}, outputs: {} }])
    ).toEqual(['@anthropic-ai/sdk'])
  })

  it('runs Claude transcript and SDK MCP behavior with API SDK loading forbidden', async () => {
    const script = `
      import assert from 'node:assert/strict'
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === '@anthropic-ai/sdk' || specifier.startsWith('@anthropic-ai/sdk/'))
          throw new Error('Type-only API SDK requested at runtime')
        return next(specifier, context)
      } })
      await assert.rejects(import('@anthropic-ai/sdk'), /Type-only API SDK/)
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const acp = await import('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')
      assert.equal(typeof acp.ClaudeAcpAgent, 'function')
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const messages = await sdk.getSessionMessages(sessionId, {
        dir: process.cwd(),
        sessionStore: { append: async () => {}, load: async () => [
          { type: 'user', uuid: 'u1', parentUuid: null, sessionId,
            message: { role: 'user', content: 'synthetic input' } },
          { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId,
            parent_tool_use_id: null, message: { id: 'm1', role: 'assistant',
              content: [{ type: 'text', text: 'synthetic reply' }] } }
        ] }
      })
      assert.equal(messages.length, 2)
      assert.equal(messages[1].message.content[0].text, 'synthetic reply')
      const { z } = await import('zod')
      const server = sdk.createSdkMcpServer({ name: 'packaging-test', version: '1.0.0', tools: [
        sdk.tool('add', 'Add synthetic inputs', { a: z.number(), b: z.number() },
          async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }))
      ] })
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'packaging-test', version: '1.0.0' })
      try {
        await server.instance.connect(serverTransport)
        await client.connect(clientTransport)
        const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } })
        assert.equal(result.content[0].text, '5')
      } finally {
        await client.close()
        await server.instance.close()
      }
      console.log('Claude runtime without API SDK: PASS')
    `
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { timeout: 15_000 }
    )
    expect(stdout).toContain('Claude runtime without API SDK: PASS')
  }, 20_000)

  it('omits only audited renderer roots and keeps unclassified and dynamic runtime dependencies', () => {
    const dependencies = {
      '@radix-ui/react-focus-scope': '1',
      '@rc-component/qrcode': '1',
      'react-markdown': '1',
      'react-remove-scroll': '1',
      tiff: '1',
      '@anthropic-ai/claude-agent-sdk': '1',
      '@aipoch/credential-identity-probe-native': '1',
      'future-runtime-package': '1'
    }
    expect(desktopBackendDependencies(dependencies, [{ inputs: {}, outputs: {} }])).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@aipoch/credential-identity-probe-native',
      'future-runtime-package'
    ])
    expect(Object.keys(dependencies)).toHaveLength(8)
  })

  it('retains a renderer root when a backend worker imports its subpath', () => {
    const dependencies = { '@rc-component/qrcode': '1', tiff: '1' }
    expect(
      desktopBackendDependencies(dependencies, [
        { inputs: {}, outputs: { 'index.cjs': { imports: [] } } },
        {
          inputs: {},
          outputs: {
            'worker.cjs': {
              imports: [{ path: '@rc-component/qrcode/lib/index', external: true }]
            }
          }
        }
      ])
    ).toEqual(['@rc-component/qrcode'])
  })

  it.each(['/', '\\'])(
    'prunes development files without changing standalone staging (%s)',
    (separator) => {
      const manifest = {
        name: 'dependency',
        exports: { '.': { types: './index.d.ts', default: './index.js' } }
      }
      const desktop = createDesktopDependencyFilter(manifest)
      for (const file of [
        'index.d.ts',
        'lib/index.d.mts',
        'index.d.cts',
        'lib/index.d.ts.map',
        'tests/fixture.json',
        'examples/demo.js'
      ]) {
        const path = file.replaceAll('/', separator)
        expect(backendDependencyIncludes(manifest, path)).toBe(true)
        expect(desktop(path, false)).toBe(false)
      }
      for (const file of [
        'index.js',
        'src/index.ts',
        'lib/test/parser.js',
        'lib/index.js.map',
        'README.md',
        'resources/SKILL.md',
        'assets/model.wasm',
        'build/Release/addon.node',
        'tests/LICENSE.txt',
        'examples/licenses/third-party.txt'
      ]) {
        expect(desktop(file.replaceAll('/', separator), false)).toBe(true)
      }
    }
  )

  it('retains runtime entry roots, wildcard exports and first-party diagnostics', () => {
    const desktop = createDesktopDependencyFilter({
      name: 'dependency',
      main: './tests/main.js',
      bin: { cli: './example/cli.js' },
      exports: { './fixtures/*': './examples/*.js', './literal': './runtime.d.ts' }
    })
    for (const path of [
      'tests/main.js',
      'tests/data.json',
      'example/cli.js',
      'examples/worker.js',
      'runtime.d.ts'
    ])
      expect(desktop(path, false)).toBe(true)
    const firstParty = createDesktopDependencyFilter({ name: '@aipoch/connector-core' })
    expect(firstParty('dist/index.d.ts', false)).toBe(true)
    expect(firstParty('dist/index.js.map', false)).toBe(true)
    const wildcard = createDesktopDependencyFilter({ name: 'fixture', exports: { './*': './*' } })
    expect(wildcard('tests/data.json', false)).toBe(true)
    expect(wildcard('schema.d.ts', false)).toBe(true)
    expect(desktop('examples/directory.d.ts', true)).toBe(true)
  })

  it('copies a real dependency tree with nested notices and loadable runtime assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-dependency-'))
    const source = join(root, 'source')
    const destination = join(root, 'desktop')
    const manifest = { name: 'fixture', main: 'index.cjs' }
    const files = {
      'package.json': JSON.stringify(manifest),
      'index.cjs':
        "module.exports = require('node:fs').readFileSync(require('node:path').join(__dirname, 'resources/SKILL.md'), 'utf8')",
      'resources/SKILL.md': 'Runtime instructions',
      'index.d.ts': 'export {}',
      'tests/test.cjs': "throw new Error('not runtime')",
      'tests/nested/NOTICE.txt': 'Redistribution notice'
    }
    try {
      for (const [file, contents] of Object.entries(files)) {
        await mkdir(join(source, file, '..'), { recursive: true })
        await writeFile(join(source, file), contents)
      }
      const desktop = createDesktopDependencyFilter(manifest)
      await cp(source, destination, {
        recursive: true,
        filter: async (path) =>
          backendDependencyIncludes(manifest, relative(source, path)) &&
          desktop(relative(source, path), (await stat(path)).isDirectory())
      })
      expect(await readFile(join(destination, 'tests/nested/NOTICE.txt'), 'utf8')).toBe(
        'Redistribution notice'
      )
      for (const file of ['index.d.ts', 'tests/test.cjs'])
        await expect(readFile(join(destination, file))).rejects.toMatchObject({ code: 'ENOENT' })
      const { createRequire } = await import('node:module')
      expect(createRequire(join(destination, 'package.json'))('./index.cjs')).toBe(
        'Runtime instructions'
      )
      expect(await readFile(join(source, 'index.d.ts'), 'utf8')).toBe('export {}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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
  'resilient-download',
  'providers',
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
