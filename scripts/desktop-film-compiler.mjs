/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { glob, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'

const compilerRoots = new Set(['@babel/core', '@babel/plugin-transform-modules-commonjs'])
const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))

export function privateFilmDirectories(stage, film, edges, inputs) {
  // Walk the actual staged instances. Other consumers and nested versions retain their paths.
  const keep = new Set()
  const visit = (dir) => {
    if (keep.has(dir)) return
    keep.add(dir)
    for (const [name, child] of edges.get(dir) ?? [])
      if (dir !== film || !compilerRoots.has(name)) visit(child)
  }
  visit(stage)
  for (const input of inputs) {
    const parts = input.split(/[\\/]/)
    const start = parts.lastIndexOf('node_modules') + 1
    const end = start + (parts[start].startsWith('@') ? 2 : 1)
    const dir = join(stage, ...parts.slice(0, end))
    if (dir !== film && keep.has(dir)) return
  }
  const dirs = new Set([...edges.values()].flatMap((children) => [...children.values()]))
  const removed = [...dirs].filter((dir) => !keep.has(dir)).sort()
  for (const dir of removed) {
    const rel = relative(join(stage, 'node_modules'), dir)
    if (
      !rel ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      [...keep].some((p) => p.startsWith(dir + sep))
    )
      throw new Error(`Cannot prune staged compiler dependency: ${dir}`)
  }
  return removed
}

export async function bundleDesktopFilmCompiler(stage, edges) {
  const film = edges.get(stage)?.get('@aipoch/research-film')
  if (!film) return
  const direct = edges.get(film)
  if (!direct || [...compilerRoots].some((name) => !direct.has(name))) return
  for (const name of compilerRoots) {
    if ((await readManifest(direct.get(name))).version !== '7.29.7') return
  }
  // Pin the two dynamic dataset requires below. On updates ship the normal tree.
  const filmRequire = createRequire(join(film, 'package.json'))
  const babelRequire = createRequire(filmRequire.resolve('@babel/core'))
  const targetsRequire = createRequire(babelRequire.resolve('@babel/helper-compilation-targets'))
  const browserslist = dirname(targetsRequire.resolve('browserslist'))
  if ((await readManifest(browserslist)).version !== '4.28.8') return
  const entry = join(film, 'dist/session-app-bundle.js')
  for await (const file of glob('dist/**/*.{js,cjs,mjs}', { cwd: film })) {
    if (join(film, file) === entry) continue
    const source = await readFile(join(film, file), 'utf8')
    if ([...compilerRoots].some((name) => source.includes(name))) return
  }
  const data = dirname(
    createRequire(join(browserslist, 'node.js')).resolve('caniuse-lite/package.json')
  )
  const { metafile, outputFiles } = await build({
    absWorkingDir: stage,
    entryPoints: [entry],
    outfile: join(film, 'dist/session-app-compiler.cjs'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    bundle: true,
    metafile: true,
    write: false,
    sourcemap: true,
    // Keep the shared fflate and optional upstream lookups under ordinary Node resolution.
    external: ['fflate', 'supports-color', '@babel/preset-typescript'],
    plugins: [
      {
        name: 'browserslist-datasets',
        setup(builder) {
          builder.onLoad({ filter: /[\\/]browserslist[\\/]node\.js$/ }, async ({ path }) => {
            if (path !== join(browserslist, 'node.js'))
              throw new Error('Unexpected Browserslist copy')
            const source = await readFile(path, 'utf8')
            const prefix = "require('caniuse-lite/data/"
            if (source.split(prefix).length !== 3)
              throw new Error('Browserslist dataset imports changed')
            const rel = relative(browserslist, data).split(sep).join('/')
            // esbuild expands relative require globs into lazy module tables at build time.
            return {
              contents: source.replaceAll(
                prefix,
                `require('${rel.startsWith('.') ? rel : './' + rel}/data/`
              ),
              resolveDir: browserslist
            }
          })
        }
      }
    ]
  })
  for (const input of Object.keys(metafile.inputs)) {
    if (!resolve(stage, input).startsWith(join(stage, 'node_modules') + sep))
      throw new Error(`Film compiler resolved outside the shipped dependency tree: ${input}`)
  }
  for (const group of ['features', 'regions']) {
    const directory = join(data, 'data', group)
    for (const file of await readdir(directory)) {
      const input = relative(stage, join(directory, file)).split(sep).join('/')
      if (file.endsWith('.js') && !Object.hasOwn(metafile.inputs, input))
        throw new Error(`Missing Browserslist dataset in film compiler: ${input}`)
    }
  }
  const removed = privateFilmDirectories(stage, film, edges, Object.keys(metafile.inputs))
  if (!removed) return
  const notices = []
  for (const dir of removed) {
    const manifest = await readManifest(dir)
    for await (const file of glob('**/*', {
      cwd: dir,
      exclude: ['node_modules/**'],
      withFileTypes: true
    })) {
      if (!file.isFile()) continue
      const name = relative(dir, join(file.parentPath, file.name)).split(sep).join('/')
      if (
        name !== 'package.json' &&
        !/(?:^|\/)(?:licen[cs]es?|notices?|copyright|copying|readme)(?:[._/-]|$)/i.test(name)
      )
        continue
      notices.push(
        `${manifest.name}@${manifest.version} — ${name}\n${await readFile(join(dir, name), 'utf8')}`
      )
    }
  }
  await writeFile(join(film, 'compiler-notices.txt'), notices.sort().join('\n\n'))
  for (const output of outputFiles) await writeFile(output.path, output.contents)
  await writeFile(
    entry,
    "import compiler from './session-app-compiler.cjs'\nexport const { bundleSessionApp } = compiler\n"
  )
  const pkg = await readManifest(film)
  for (const name of compilerRoots) delete pkg.dependencies[name]
  await writeFile(join(film, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  for (const dir of removed) {
    await rm(dir, { recursive: true, force: true })
  }
}
