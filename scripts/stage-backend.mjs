/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  backendDependencyIncludes,
  createDesktopDependencyFilter,
  desktopBackendDependencies,
  desktopBackendPeerDependencies,
  desktopBundledDependencies,
  isBackendRuntimeDependency,
  isElectronPackage,
  prismaEngineFilenames
} from './backend-dependencies.mjs'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { desktop: { type: 'boolean', default: false } } })
const stage = join(root, values.desktop ? 'out/desktop-backend' : 'out/standalone')
const backend = join(root, values.desktop ? 'out/desktop-backend-build' : 'out/backend')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const cliManifest = JSON.parse(
  await readFile(join(root, 'packages/open-science/package.json'), 'utf8')
)
const forbidden = isElectronPackage
const metadata = values.desktop
  ? JSON.parse(await readFile(join(backend, 'dependencies.json'), 'utf8'))
  : []
const bundledDependencies = desktopBundledDependencies(metadata)
const dependencyRoots = values.desktop
  ? desktopBackendDependencies(manifest.dependencies, metadata)
  : Object.keys(manifest.dependencies)
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await cp(backend, join(stage, 'out/backend'), { recursive: true })
await cp(join(root, 'out/web'), join(stage, 'out/web'), { recursive: true })
await cp(join(root, 'resources'), join(stage, 'resources'), {
  recursive: true,
  filter: (path) => !relative(join(root, 'resources'), path).split(sep).includes('bin')
})
const platformDirectory = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const micromamba = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
await cp(
  join(root, 'resources/bin', platformDirectory, process.arch, micromamba),
  join(stage, 'resources', micromamba)
)
if (process.platform === 'win32')
  await cp(
    join(root, 'resources/bin/win', process.arch, 'micromamba-compat.exe'),
    join(stage, 'resources/micromamba-compat.exe')
  )
// The bundled sandbox code resolves its native helpers from the backend's own resource root.
if (process.platform === 'win32') {
  await cp(
    join(root, 'packages/notebook-network-sandbox/vendor/windows', process.arch),
    join(stage, 'resources/notebook-network-sandbox/windows', process.arch),
    { recursive: true }
  )
  await cp(
    join(root, 'packages/notebook-network-sandbox/vendor/wsl2/manifest.json'),
    join(stage, 'resources/notebook-network-sandbox/wsl2/manifest.json'),
    { recursive: true }
  )
}
for (const file of await readdir(join(root, 'packages/open-science'))) {
  if (/\.(?:mjs|cjs|d\.ts|d\.mts|d\.cts)$/.test(file) && !file.includes('.test.'))
    await cp(join(root, 'packages/open-science', file), join(stage, file))
}
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'))
await cp(join(root, 'packages/open-science/README.md'), join(stage, 'README.md'))
await cp(join(root, 'packages/open-science/CLI.md'), join(stage, 'CLI.md'))

const installed = new Map()
async function packageDirectory(name, from) {
  let directory = from
  while (true) {
    const candidate = join(directory, 'node_modules', name)
    try {
      await stat(join(candidate, 'package.json'))
      return await realpath(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Missing backend dependency: ${name}`)
    directory = parent
  }
}
async function copyDependency(name, from, destinationParent = stage) {
  if (forbidden(name)) throw new Error(`Standalone dependency closure includes ${name}`)
  if (bundledDependencies.has(name))
    throw new Error(
      `External dependency at ${from} requires bundled ${name}; keep it external instead.`
    )
  const source = await packageDirectory(name, from)
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  let destination = join(destinationParent, 'node_modules', name)
  const atRoot = installed.get(join(stage, 'node_modules', name))
  if (atRoot === pkg.version) return
  if (!atRoot) destination = join(stage, 'node_modules', name)
  if (installed.get(destination) === pkg.version) return
  installed.set(destination, pkg.version)
  const desktopIncludes = values.desktop ? createDesktopDependencyFilter(pkg) : undefined
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: async (path) => {
      const file = relative(source, path)
      return (
        backendDependencyIncludes(pkg, file) &&
        (!desktopIncludes || desktopIncludes(file, (await stat(path)).isDirectory()))
      )
    }
  })
  // These are prebuilt target artifacts. npm must not reinterpret them as a source installation.
  if (name.startsWith('@aipoch/') || name === '@prisma/client') {
    delete pkg.scripts
    pkg.gypfile = false
    await writeFile(join(destination, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  }
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (!isBackendRuntimeDependency(dependency, name)) continue
    try {
      await copyDependency(dependency, source, destination)
    } catch (error) {
      if (
        !(dependency in (pkg.optionalDependencies ?? {})) ||
        !error.message.startsWith('Missing backend dependency:')
      )
        throw error
    }
  }
  const peerDependencies = values.desktop
    ? desktopBackendPeerDependencies(pkg)
    : Object.keys(pkg.peerDependencies ?? {})
  for (const dependency of peerDependencies) {
    if (!isBackendRuntimeDependency(dependency, name)) continue
    try {
      await copyDependency(dependency, source, destination)
    } catch (error) {
      if (
        !pkg.peerDependenciesMeta?.[dependency]?.optional ||
        !error.message.startsWith('Missing backend dependency:')
      )
        throw error
    }
  }
}
const dependencies = {}
for (const name of dependencyRoots) {
  if (forbidden(name) || name === '@aipoch/notebook-network-sandbox') continue
  await copyDependency(name, root)
  dependencies[name] = installed.get(join(stage, 'node_modules', name))
}
// This HTTP implementation is a direct standalone dependency, independent of incidental hoisting.
await copyDependency('undici', root)
dependencies.undici = installed.get(join(stage, 'node_modules/undici'))
// Fail if a new peer edge reintroduces development tooling into a shipped dependency closure.
for (const name of ['prisma', '@prisma/engines', 'typescript']) {
  if ([...installed.keys()].some((path) => path.endsWith(join('node_modules', name))))
    throw new Error(`Build-time dependency leaked into the backend: ${name}`)
}
// npm pack excludes generated hidden .prisma directories even when @prisma/client is bundled.
// Ship the generated client as an explicit resource and keep the public package facade intact.
const prismaEngines = prismaEngineFilenames()
const generatedPrisma = await readFile(join(root, 'node_modules/.prisma/client/index.js'), 'utf8')
if (
  !generatedPrisma.includes("require('@prisma/client/runtime/library.js')") ||
  !/"engineType"\s*:\s*"library"/.test(generatedPrisma)
)
  throw new Error('Prisma runtime pruning requires a generated native library client.')
for (const engine of prismaEngines) await stat(join(root, 'node_modules/.prisma/client', engine))
await cp(join(root, 'node_modules/.prisma/client'), join(stage, 'resources/prisma-client'), {
  recursive: true,
  dereference: true,
  filter: (path) => {
    const file = relative(join(root, 'node_modules/.prisma/client'), path)
    return !file.includes('query_engine-') || prismaEngines.includes(file)
  }
})
for (const entry of ['index.js', 'default.js']) {
  await writeFile(
    join(stage, 'node_modules/@prisma/client', entry),
    "module.exports = require('../../../resources/prisma-client/index.js')\n"
  )
}
// Compiler intermediates are unsigned Mach-O objects: if one reaches the staged tree, packaged
// signature verification (scripts/verify-runtime-signatures.mjs) fails on the Release cli-artifacts
// legs. Fail here at staging time instead, where the log is easy to read.
const assertNoBuildIntermediates = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'obj.target') {
        throw new Error(`Staged backend dependency contains build intermediates: ${path}`)
      }
      await assertNoBuildIntermediates(path)
    } else if (entry.name.endsWith('.o')) {
      throw new Error(`Staged backend dependency contains a compiler intermediate: ${path}`)
    }
  }
}
await assertNoBuildIntermediates(join(stage, 'node_modules'))
const nativeRequire = createRequire(join(stage, 'package.json'))
// GPU providers are pruned only on Linux x64; its native binding must still load.
// Do not add a gate on other targets: ONNX 1.24.3 ships no Darwin x64 binding.
if (process.platform === 'linux' && process.arch === 'x64') nativeRequire('onnxruntime-node')
for (const name of ['@aipoch/process-tree-native', '@aipoch/safe-file-publisher-native'])
  nativeRequire(name)
for (const path of Object.values(nativeRequire('@aipoch/credential-identity-probe-native')))
  await stat(path)
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      ...cliManifest,
      version: manifest.version,
      description: 'Open-Science standalone Node backend, CLI and SDK',
      files: ['*.mjs', '*.d.ts', '*.d.mts', 'LICENSE', 'README.md', 'CLI.md', 'out', 'resources'],
      os: [process.platform],
      cpu: [process.arch],
      engines: { node: '>=22.13.0' },
      dependencies,
      bundledDependencies: Object.keys(dependencies)
    },
    null,
    2
  ) + '\n'
)
console.log(
  `Staged ${process.platform}/${process.arch} ${values.desktop ? 'desktop' : 'standalone'} artifact at ${stage}; ${installed.size} dependency placements, no Electron.`
)
