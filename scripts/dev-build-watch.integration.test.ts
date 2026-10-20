import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, createLogger, type ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'
import { buildDevPackages } from './build-dev-packages.mjs'
import { devBuildWatch } from './dev-build-watch.mjs'

it('watches real package edits, refreshes optimized CJS only after success and closes its watcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-build-watch-'))
  const put = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  const json = (file: string, value: unknown): Promise<void> => put(file, JSON.stringify(value))
  let server: ViteDevServer | undefined
  const logger = createLogger('silent')
  const info = vi.spyOn(logger, 'info')
  const warn = vi.spyOn(logger, 'warn')
  try {
    await put(
      'packages/open-science/installation-startup.cjs',
      await readFile(
        new URL('../packages/open-science/installation-startup.cjs', import.meta.url),
        'utf8'
      )
    )
    await json('package.json', { dependencies: {} })
    await json('packages/core/package.json', {
      name: 'fixture-core',
      main: './dist/index.js',
      types: './dist/index.d.ts'
    })
    await json('packages/core/tsconfig.dev.json', {
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        types: [],
        declaration: true,
        composite: true,
        noEmitOnError: true,
        outDir: './dist',
        rootDir: './src',
        tsBuildInfoFile: './.cache/dev.tsbuildinfo'
      },
      include: ['./src/**/*.ts']
    })
    await json('tsconfig.packages.json', {
      files: [],
      references: [{ path: './packages/core/tsconfig.dev.json' }]
    })
    await put('packages/core/src/index.ts', 'export const value: string = "watch-before"')
    await put('src/main/node-entry.ts', 'console.log("backend")')
    await json('src/shared/i18n/locales/de.json', { common: {}, native: {}, renderer: {} })
    await put('index.html', '<script type="module" src="/main.js"></script>')
    await put('main.js', 'import { value } from "fixture-core"; console.log(value)')
    await mkdir(join(root, 'node_modules'))
    await symlink(
      join(root, 'packages/core'),
      join(root, 'node_modules/fixture-core'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await buildDevPackages({ root, log: () => {} })
    server = await createServer({
      root,
      configFile: false,
      customLogger: logger,
      plugins: [devBuildWatch(root)],
      optimizeDeps: { include: ['fixture-core'] },
      server: { middlewareMode: true, ws: false }
    })
    const optimizerCode = async (): Promise<string> => {
      const optimizer = server!.environments.client.depsOptimizer!
      await optimizer.scanProcessing
      await Promise.all(
        Object.values(optimizer.metadata.discovered).map((entry) => entry.processing)
      )
      const entry = optimizer.metadata.optimized['fixture-core']
      return entry ? readFile(entry.file, 'utf8') : ''
    }
    await vi.waitFor(async () => expect(await optimizerCode()).toContain('watch-before'), {
      timeout: 15_000
    })
    const restart = vi.spyOn(server, 'restart')
    await put('packages/core/src/index.ts', 'export const value: string = 42')
    await vi.waitFor(
      () => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Build failed')),
      { timeout: 15_000 }
    )
    expect(restart).not.toHaveBeenCalled()
    await put('packages/core/src/index.ts', 'export const value: string = "watch-after"')
    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith(true), { timeout: 15_000 })
    await Promise.all(restart.mock.results.map((result) => result.value))
    await vi.waitFor(async () => expect(await optimizerCode()).toContain('watch-after'), {
      timeout: 15_000
    })
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('the running backend was not restarted')
    )
    await server.close()
    const count = info.mock.calls.length
    await put('packages/core/src/index.ts', 'export const value: string = "after-close"')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(info.mock.calls).toHaveLength(count)
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
