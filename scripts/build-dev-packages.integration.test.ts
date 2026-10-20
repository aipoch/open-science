import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { packageRegistry } from './package-verification-plan.mjs'
import { buildDevPackages, packageBuildProjects } from './build-dev-packages.mjs'

it('registers every buildable local package and its declared internal dependencies', async () => {
  const root = process.cwd()
  const app = JSON.parse(await readFile('package.json', 'utf8'))
  const packages = new Map<string, string>()
  const manifests = new Map<
    string,
    { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
  >()
  const localDependencies = { ...app.devDependencies, ...app.dependencies }
  for (const [name, version] of Object.entries(localDependencies)) {
    if (typeof version !== 'string' || !version.startsWith('file:')) continue
    const path = resolve(root, version.slice(5))
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (!manifest.scripts?.build) continue
    packages.set(name, path)
    manifests.set(path, manifest)
  }
  const projects = packageBuildProjects(root)
  expect(projects.map((project) => project.root).sort()).toEqual([...packages.values()].sort())
  for (const project of projects) {
    const manifest = manifests.get(project.root)!
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
      .flatMap((name) => (packages.has(name) ? [packages.get(name)] : []))
      .sort()
    expect(
      (project.config.projectReferences ?? []).map((ref) => dirname(resolve(ref.path))).sort()
    ).toEqual(dependencies)
    expect(project.config.options).toMatchObject({ composite: true, noEmitOnError: true })
    const standalone = JSON.parse(await readFile(join(project.root, 'tsconfig.json'), 'utf8'))
    expect(standalone.references).toBeUndefined()
    const registered = packageRegistry().packages.find(
      (entry) => resolve(root, entry.root) === project.root
    )
    if (registered)
      expect(registered.dependencies.map((path) => resolve(root, path)).sort()).toEqual(
        dependencies
      )
  }
})

it('skips unchanged output, propagates dependency edits, rejects errors and repairs deleted output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-package-build-'))
  const put = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  const json = (file: string, value: unknown): Promise<void> => put(file, JSON.stringify(value))
  const build = (): Promise<void> =>
    buildDevPackages({ root, packages: ['consumer'], log: () => {} })
  try {
    for (const name of ['core', 'consumer']) {
      await json(`packages/${name}/package.json`, {
        name: `fixture-${name}`,
        main: './dist/index.js',
        types: './dist/index.d.ts',
        scripts: { 'build:assets': 'node assets.cjs' }
      })
      await json(`packages/${name}/tsconfig.json`, {
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          strict: true,
          types: [],
          declaration: true,
          outDir: 'dist',
          rootDir: 'src'
        },
        include: ['src/**/*.ts']
      })
      await json(`packages/${name}/tsconfig.dev.json`, {
        extends: './tsconfig.json',
        compilerOptions: {
          composite: true,
          noEmitOnError: true,
          tsBuildInfoFile: './.cache/dev.tsbuildinfo'
        },
        ...(name === 'consumer' ? { references: [{ path: '../core/tsconfig.dev.json' }] } : {})
      })
    }
    // Deliberately list the consumer first: the compiler must order the referenced project.
    await json('tsconfig.packages.json', {
      files: [],
      references: [
        { path: './packages/consumer/tsconfig.dev.json' },
        { path: './packages/core/tsconfig.dev.json' }
      ]
    })
    await mkdir(join(root, 'node_modules'))
    await symlink(
      join(root, 'packages', 'core'),
      join(root, 'node_modules/fixture-core'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await put(
      'packages/core/assets.cjs',
      `
      const fs = require('node:fs')
      fs.writeFileSync('dist/asset.json', JSON.stringify(require('./dist/index.js').value))
    `
    )
    await put(
      'packages/consumer/assets.cjs',
      `
      const fs = require('node:fs')
      const asset = JSON.parse(fs.readFileSync('../core/dist/asset.json', 'utf8'))
      if (asset !== require('./dist/index.js').result) throw new Error('Dependency assets must build first')
    `
    )
    await put('packages/core/src/index.ts', 'export const value = "before"')
    await put('packages/core/src/obsolete.ts', 'export const unused = 1')
    await put(
      'packages/consumer/src/index.ts',
      'import { value } from "fixture-core"; export const result: string = value'
    )
    await build()
    const output = join(root, 'packages/consumer/dist/index.js')
    const asset = join(root, 'packages/core/dist/asset.json')
    expect(JSON.parse(await readFile(asset, 'utf8'))).toBe('before')
    await rm(asset)
    const previous = await stat(output)
    await build()
    expect(JSON.parse(await readFile(asset, 'utf8'))).toBe('before')
    expect((await stat(output)).mtimeMs).toBe(previous.mtimeMs)
    expect((await stat(output)).ctimeMs).toBe(previous.ctimeMs)
    await put('packages/core/src/index.ts', 'export const value = "after"')
    await build()
    const result = execFileSync(
      process.execPath,
      ['-e', 'console.log(require("./packages/consumer/dist").result)'],
      { cwd: root, encoding: 'utf8' }
    )
    expect(result.trim()).toBe('after')
    expect(JSON.parse(await readFile(asset, 'utf8'))).toBe('after')
    await put('packages/core/src/index.ts', 'export const value = 42')
    const beforeFailure = await stat(asset)
    await expect(build()).rejects.toThrow('Package build failed')
    expect((await stat(asset)).mtimeMs).toBe(beforeFailure.mtimeMs)
    await put('packages/core/src/index.ts', 'export const value = "fixed"')
    await rm(join(root, 'packages/core/src/obsolete.ts'))
    await build()
    await expect(stat(join(root, 'packages/core/dist/obsolete.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(stat(join(root, 'packages/core/dist/obsolete.d.ts'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await rm(output)
    await build()
    expect(await readFile(output, 'utf8')).toContain('fixture-core')
    await rm(join(root, 'packages/core/dist'), { recursive: true })
    await build()
    expect(await readFile(join(root, 'packages/core/dist/index.js'), 'utf8')).toContain('fixed')
    const configPath = join(root, 'packages/consumer/tsconfig.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.compilerOptions.sourceMap = true
    await writeFile(configPath, JSON.stringify(config))
    await build()
    expect(await readFile(`${output}.map`, 'utf8')).toContain('index.ts')
    const beforeClean = await readFile(output, 'utf8')
    await put('packages/consumer/dist/stale.js', 'obsolete')
    await buildDevPackages({ root, clean: true, log: () => {} })
    expect(await readFile(output, 'utf8')).toBe(beforeClean)
    expect(JSON.parse(await readFile(asset, 'utf8'))).toBe('fixed')
    await rm(asset)
    await buildDevPackages({ root, packages: ['consumer'], force: true, log: () => {} })
    expect(JSON.parse(await readFile(asset, 'utf8'))).toBe('fixed')
    await expect(stat(join(root, 'packages/consumer/dist/stale.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await put('packages/consumer/assets.cjs', 'process.exit(1)')
    await buildDevPackages({ root, packages: ['core'], log: () => {} })
    await put('packages/core/assets.cjs', 'process.exit(1)')
    await expect(build()).rejects.toThrow('Package assets failed for fixture-core')
    await expect(buildDevPackages({ root, packages: ['missing'], log: () => {} })).rejects.toThrow(
      'Unknown package'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('prepares packages once per composed command, including npm lifecycle hooks', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'))
  const expand = (name: string, extra = ''): string[] => {
    const commands: string[] = []
    if (scripts[`pre${name}`]) commands.push(...expand(`pre${name}`))
    for (const command of scripts[name].split(' && ')) {
      const nested = /^npm run ([\w:-]+)(?: -- (.*))?$/.exec(command)
      commands.push(...(nested ? expand(nested[1], nested[2]) : [`${command} ${extra}`.trim()]))
    }
    if (scripts[`post${name}`]) commands.push(...expand(`post${name}`))
    return commands
  }
  for (const command of [
    'build',
    'build:mac',
    'build:linux',
    'build:win',
    'build:e2e',
    'stage:backend',
    'typecheck',
    'typecheck:node',
    'typecheck:web',
    'build:web',
    'build:backend'
  ]) {
    const builds = expand(command).filter((step) =>
      step.startsWith('node scripts/build-dev-packages.mjs')
    )
    expect(builds, command).toHaveLength(1)
    if (
      ['build', 'build:mac', 'build:linux', 'build:win', 'build:e2e', 'stage:backend'].includes(
        command
      )
    )
      expect(builds[0], command).toContain('--clean')
  }
})
