/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'

const certificateVersions = {
  ...Object.fromEntries(
    [
      'asym-key',
      'cms',
      'csr',
      'ecc',
      'pfx',
      'pkcs8',
      'pkcs9',
      'rsa',
      'schema',
      'x509',
      'x509-attr',
      'x509-post-quantum'
    ].map((name) => [`@peculiar/asn1-${name}`, ['2.9.4']])
  ),
  '@peculiar/utils': ['2.0.3'],
  asn1js: ['3.0.10'],
  pvtsutils: ['1.3.6'],
  pvutils: ['1.1.5'],
  tsyringe: ['4.10.0'],
  // Resolve both versions from their original importers, including tsyringe's nested 1.x.
  tslib: ['1.14.1', '2.8.1']
}
const packageName = (path) =>
  path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]

async function packageDirectory(name, from) {
  let directory = dirname(createRequire(join(from, 'package.json')).resolve(name))
  for (;;) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    })
    if (JSON.parse(manifest).name === name) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Missing package root: ${name}`)
    directory = parent
  }
}

// These graphs have one public runtime owner. Do not bundle shared schema/container libraries
// into application entry points: their canonical package must still own their module instances.
export async function stageDesktopDependencyChain(manifest, source, destination) {
  const font = manifest.name === 'fontkit' && manifest.version === '2.0.4'
  const certificate = manifest.name === '@peculiar/x509' && manifest.version === '2.1.0'
  if (!font && !certificate) return undefined
  const versions = font ? { '@swc/helpers': ['0.5.23'], tslib: ['2.8.1'] } : certificateVersions
  const packages = new Map()
  let audited = true
  const visit = async (name, from) => {
    const directory = await packageDirectory(name, from)
    if (packages.has(directory)) return
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (!versions[name]?.includes(pkg.version)) {
      audited = false
      return
    }
    packages.set(directory, pkg)
    for (const child of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies
    }))
      await visit(child, directory)
  }
  for (const name of font ? ['@swc/helpers'] : Object.keys(manifest.dependencies))
    await visit(name, source)
  // Re-audit the whole graph on upgrades; never partly transform an unknown closure.
  if (!audited) return undefined
  const { build } = await import('esbuild')
  const included = new Set()
  const entries = font
    ? [
        ['dist/main.cjs', 'cjs'],
        ['dist/module.mjs', 'esm']
      ]
    : [['build/x509.cjs.js', 'cjs']]
  await mkdir(destination, { recursive: true })
  for (const [entry, format] of entries) {
    const result = await build({
      absWorkingDir: source,
      entryPoints: [entry],
      outfile: join(destination, entry),
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node22',
      format,
      sourcemap: true,
      metafile: true,
      plugins: [
        {
          name: 'audited-private-dependencies',
          setup(plugin) {
            plugin.onResolve({ filter: /^[^./]/ }, ({ path, resolveDir }) => {
              const name = packageName(path)
              if (!(name in versions)) return undefined
              const file = createRequire(join(resolveDir, 'package.json')).resolve(path)
              if (
                ![...packages].some(
                  ([directory, pkg]) => pkg.name === name && file.startsWith(directory + sep)
                )
              )
                throw new Error(`Unaudited dependency resolution: ${path} from ${resolveDir}`)
              return { path: file }
            })
          }
        }
      ]
    })
    for (const input of Object.keys(result.metafile.inputs)) {
      const file = resolve(source, input)
      for (const [directory, pkg] of packages)
        if (file.startsWith(directory + sep)) included.add(pkg.name)
    }
  }
  const notices = []
  for (const [directory, pkg] of packages) {
    if (!included.has(pkg.name)) continue
    const licenses = (await readdir(directory))
      .filter((name) => /^(licen[sc]e|notice|copying|copyright)/i.test(name))
      .sort()
    if (!licenses.length) throw new Error(`Missing bundled dependency license: ${pkg.name}`)
    for (const file of licenses)
      notices.push(
        `${pkg.name}@${pkg.version} — ${file}\n\n${await readFile(join(directory, file), 'utf8')}`
      )
  }
  await writeFile(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'))
  // fontkit's published 2.0.4 tarball includes its license declaration in package.json,
  // but no LICENSE file. Preserve all supplied root metadata in either package.
  for (const file of font
    ? ['package.json', 'README.md']
    : ['package.json', 'LICENSE', 'README.md'])
    await cp(join(source, file), join(destination, file))
  return included
}

// tslib exports stateless compiler helpers; its independently resolved external copies remain
// valid. Every other private graph member must have no separate staged consumer/instance.
export function assertPrivateDependencyChain(name, included) {
  if (name !== 'tslib' && included.has(name))
    throw new Error(
      `External consumer requires bundled private dependency ${name}; keep its graph external.`
    )
}
