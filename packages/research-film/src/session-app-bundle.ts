import { posix } from 'node:path'
import { transformSync, types as t, type PluginObj } from '@babel/core'
import commonJs from '@babel/plugin-transform-modules-commonjs'
import { unzipSync, strFromU8 } from 'fflate'

export type SessionAppDescription = {
  name: string
  modules: number
  api: string[]
  packages: string[]
}
export type SessionAppBundle = { description: SessionAppDescription; code: string }

/** Read a closed module graph in memory. Nothing in the archive runs on the host. */
export function bundleSessionApp(bytes: Uint8Array, name: string): SessionAppBundle | undefined {
  let size = 0
  let entries = 0
  const files = unzipSync(bytes, {
    filter(entry) {
      if (++entries > 4096) throw new Error('Too many app archive entries.')
      if (!/\.(html|m?js)$/i.test(entry.name) || entry.name.startsWith('__MACOSX/')) return false
      if (
        entry.name.includes('\\') ||
        entry.name.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Invalid app archive path.')
      size += entry.originalSize
      if (size > 16 * 1024 * 1024) throw new Error('App sources exceed 16 MiB.')
      return true
    }
  })
  const index = Object.keys(files)
    .filter((path) => /(^|\/)index\.html$/i.test(path))
    .sort((a, b) => a.length - b.length)[0]
  if (!index) return undefined
  const root = posix.dirname(index)
  const html = strFromU8(files[index])
  const tags = Array.from(
    html.matchAll(/<script\b([^>]*?)>([\s\S]*?)<\/script\s*>/gi),
    (match) => ({
      attrs: Object.fromEntries(
        Array.from(match[1].matchAll(/([^\s=]+)\s*=\s*(["'])(.*?)\2/g), (a) => [
          a[1].toLowerCase(),
          a[3]
        ])
      ),
      body: match[2]
    })
  )
  const entry = tags.find((tag) => tag.attrs.type === 'module' && tag.attrs.src)?.attrs.src
  if (!entry) return undefined
  const map =
    JSON.parse(tags.find((tag) => tag.attrs.type === 'importmap')?.body || '{}').imports ?? {}
  const packages = new Map<string, string>()
  const resolve = (id: string, from: string): string => {
    const bare = !id.startsWith('.') && !id.startsWith('/')
    const target = bare ? (Object.hasOwn(map, id) ? map[id] : undefined) : id
    if (typeof target !== 'string' || /[:\\?#%]/.test(target) || target.startsWith('//'))
      throw new Error('The app requires an unavailable or nonlocal module.')
    let path = posix.normalize(
      posix.join(bare || target.startsWith('/') ? root : posix.dirname(from), target)
    )
    if (!Object.hasOwn(files, path) && !posix.extname(path)) path += '.js'
    if (
      !Object.hasOwn(files, path) ||
      !/\.m?js$/i.test(path) ||
      (root !== '.' && !path.startsWith(root + '/'))
    )
      throw new Error('The app has a missing local module.')
    if (bare) packages.set(id, path)
    return path
  }
  const declarations = new Map<string, string>()
  const visiting = new Set<string>()
  const publicPaths = new Set<string>()
  const api: string[] = []
  const compile = (path: string, entryOnly = false): string[] => {
    if (visiting.has(path)) throw new Error('App module cycle.')
    if (declarations.has(path)) return []
    if (declarations.size + visiting.size >= 256) throw new Error('Too many app modules.')
    visiting.add(path)
    const source = strFromU8(files[path])
    const imports = new Map<string, string>()
    const inspect = (): PluginObj => ({
      visitor: {
        Program(program) {
          for (const node of program.node.body) {
            if (
              (t.isImportDeclaration(node) ||
                t.isExportNamedDeclaration(node) ||
                t.isExportAllDeclaration(node)) &&
              node.source
            ) {
              const id = node.source.value
              imports.set(id, resolve(id, path))
            }
            if (publicPaths.has(path) && api.length < 70 && t.isExportNamedDeclaration(node)) {
              const d = node.declaration
              const end =
                d && (t.isFunctionDeclaration(d) || t.isClassDeclaration(d))
                  ? d.body?.start
                  : undefined
              const signature = d
                ? source
                    .slice(d.start!, end ?? d.end!)
                    .replace(/\s+/g, ' ')
                    .slice(0, 180)
                : node.specifiers
                    .map((s) => (t.isIdentifier(s.exported) ? s.exported.name : s.exported.value))
                    .join(', ')
              if (signature) api.push(posix.relative(root, path) + ': ' + signature.trim())
            }
          }
        },
        Import(p) {
          throw p.buildCodeFrameError('Dynamic imports are unavailable in a film.')
        },
        MetaProperty(p) {
          if (p.node.meta.name === 'import')
            throw p.buildCodeFrameError('import.meta is unavailable in a film.')
        },
        AwaitExpression(p) {
          if (!p.getFunctionParent())
            throw p.buildCodeFrameError('Top-level await is unavailable in a film.')
        }
      }
    })
    const output = transformSync(source, {
      filename: 'film-module.js',
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      ast: false,
      code: !entryOnly,
      compact: true,
      plugins: [inspect, commonJs]
    })
    const parents = [...imports.entries()]
      .filter(([id]) => id.startsWith('.') || id.startsWith('/'))
      .map(([, target]) => target)
    if (entryOnly) {
      for (const dep of parents) publicPaths.add(dep)
      for (const dep of parents) compile(dep)
    } else {
      for (const dep of imports.values()) compile(dep)
      const wiring = Object.fromEntries(
        [...imports].map(([id, dep]) => [id, posix.relative(root, dep)])
      )
      declarations.set(
        path,
        `__defs[${JSON.stringify(posix.relative(root, path))}]=[function(exports,require){${output!.code}\n},${JSON.stringify(wiring)}];`
      )
    }
    visiting.delete(path)
    return parents
  }
  const entryPath = resolve(
    entry.startsWith('.') || entry.startsWith('/') ? entry : './' + entry,
    index
  )
  const roots = compile(entryPath, true).map((p) => posix.relative(root, p))
  if (!roots.length) return undefined
  const pkgIds = Object.fromEntries(
    [...packages]
      .filter(([, p]) => declarations.has(p))
      .map(([id, p]) => [id, posix.relative(root, p)])
  )
  const code = `(function(){const __defs=Object.create(null), mods=Object.create(null);
${[...declarations.values()].join('\n')}
function load(id){if(!Object.hasOwn(mods,id)){const [run,deps]=__defs[id];mods[id]=Object.create(null);run(mods[id],name=>{if(!Object.hasOwn(deps,name))throw Error("Unknown app module");return load(deps[name])})}return mods[id]}
const api=Object.assign(Object.create(null),...${JSON.stringify(roots)}.map(load));
api.modules=mods;api.packages=Object.fromEntries(Object.entries(${JSON.stringify(pkgIds)}).map(([k,p])=>[k,load(p)]));window.APP=api;})();`
  return {
    code,
    description: { name, modules: declarations.size, api, packages: Object.keys(pkgIds) }
  }
}
