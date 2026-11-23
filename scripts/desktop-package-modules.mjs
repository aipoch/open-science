/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'

const distBundles = {
  '@aipoch/pdf-translation': [],
  '@aipoch/research-film': ['generation-worker.js', 'session-app-worker.js', 'speech-process.js']
}

const declarationPackages = new Set([
  '@aipoch/pdf-translation',
  '@aipoch/research-film',
  '@aipoch/pdf-structure',
  '@aipoch/connector-builtins'
])

const declaration = /\.d\.(?:m|c)?ts$/
const within = (directory, file) => {
  const name = relative(directory, file)
  return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)
}

async function filesIn(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function publicEntries(pkg) {
  // These four first-party packages expose explicit types/default pairs. Re-audit new
  // export conditions or legacy type mappings before optimizing a different layout.
  const entries = Object.entries(pkg.exports ?? {})
  if (
    !entries.length ||
    pkg.typesVersions ||
    pkg.types ||
    pkg.typings ||
    entries.some(
      ([key, entry]) =>
        (key !== '.' && !key.startsWith('./')) ||
        key.includes('*') ||
        !entry ||
        Object.keys(entry).sort().join(',') !== 'default,types' ||
        !/^\.\/dist\/[\w/-]+\.js$/.test(entry.default) ||
        !/^\.\/dist\/[\w/-]+\.d\.ts$/.test(entry.types)
    )
  )
    throw new Error('Unsupported desktop package exports: ' + pkg.name)
  return entries.map(([, entry]) => entry)
}

async function bundleDist(directory, pkg, entries) {
  const dist = join(directory, 'dist')
  // Workers and forked processes require real entry files, even when also imported.
  const entryPoints = [
    ...entries.map((entry) => entry.default.slice('./dist/'.length)),
    ...distBundles[pkg.name]
  ]
  const sources = (await filesIn(dist)).filter((file) => file.endsWith('.js'))
  const bundle = () =>
    build({
      absWorkingDir: dist,
      entryPoints,
      outdir: dist,
      outbase: dist,
      chunkNames: 'shared-[hash]',
      bundle: true,
      splitting: true,
      format: 'esm',
      target: 'node22',
      platform: 'node',
      packages: 'external',
      // Preserve the staged CJS compiler and its diagnostic map, and keep the JSON asset on disk.
      external: ['./session-app-compiler.cjs', './runtime-assets.json'],
      keepNames: true,
      legalComments: 'inline',
      metafile: true,
      allowOverwrite: true,
      write: false
    })
  let result = await bundle()
  // Preserve standalone modules outside the public graph, including any relative
  // imports they share with a public entry. A future standalone file stays loadable.
  const standalone = sources
    .map((file) => relative(dist, file).split(sep).join('/'))
    .filter((name) => !Object.hasOwn(result.metafile.inputs, name))
  if (standalone.length) {
    entryPoints.push(...standalone.sort())
    result = await bundle()
  }
  const outputs = new Set(result.outputFiles.map((file) => resolve(file.path)))
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  for (const file of sources) if (!outputs.has(file)) await unlink(file)
}

async function pruneDeclarations(stage, packageDirectories, publicTypes) {
  const options = { module: ts.ModuleKind.NodeNext, types: [], noLib: true, noEmit: true }
  const host = ts.createCompilerHost(options)
  // The checkout above the disposable stage also contains node_modules. Resolve
  // references against the shipped backend alone, including its other packages.
  for (const method of ['fileExists', 'directoryExists', 'readFile']) {
    const original = host[method]
    host[method] = (file) =>
      within(stage, file) ? original(file) : method === 'readFile' ? undefined : false
  }
  const roots = [...publicTypes]
  const candidates = []
  for (const file of await filesIn(stage)) {
    if (!declaration.test(file)) continue
    if (!packageDirectories.some((dir) => within(dir, file))) {
      roots.push(file)
      continue
    }
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest)
    // Retain ambient declarations and augmentations even without an incoming import.
    if (
      !ts.isExternalModule(source) ||
      source.statements.some(
        (statement) =>
          ts.isModuleDeclaration(statement) &&
          (ts.isStringLiteral(statement.name) || statement.flags & ts.NodeFlags.GlobalAugmentation)
      )
    )
      roots.push(file)
    candidates.push(file)
  }
  const program = ts.createProgram(roots, options, host)
  for (const file of publicTypes) {
    if (!program.getSourceFile(file)) throw new Error('Missing public desktop declaration: ' + file)
  }
  for (const file of candidates) if (!program.getSourceFile(file)) await unlink(file)
}

export async function compactDesktopPackageModules(stage, installed) {
  const directories = []
  const publicTypes = []
  for (const name of declarationPackages) {
    const directory = join(stage, 'node_modules', name)
    if (!installed.has(directory)) continue
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (pkg.name !== name) throw new Error('Unexpected desktop package at ' + directory)
    const entries = publicEntries(pkg)
    if (Object.hasOwn(distBundles, pkg.name)) await bundleDist(directory, pkg, entries)
    directories.push(join(directory, 'dist'))
    publicTypes.push(...entries.map((entry) => join(directory, entry.types)))
  }
  if (directories.length) await pruneDeclarations(stage, directories, publicTypes)
}
