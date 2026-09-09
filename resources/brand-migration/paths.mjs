import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, win32, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Brand copy preserves each letter's case. Underscores and identifiers are separate contracts.
export const hyphenateBrand = (value) => value.replace(/(open) ?(science)/gi, '$1-$2')
export const inspect = async (path) => {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
export const inside = (root, value, platform = process.platform) => {
  const path = platform === 'win32' ? win32 : posix
  const normalized = path.normalize(value)
  const base = path.normalize(root)
  const rel = path.relative(base, normalized)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

// Match path components, never text substrings. File URLs retain URI escaping and UNC authority.
export function remapPath(value, mappings, platform = process.platform) {
  if (typeof value !== 'string' || value.startsWith('$DATA')) return value
  const path = platform === 'win32' ? win32 : posix
  let raw = value
  const uri = /^file:/i.test(raw)
  if (uri) {
    try {
      raw = fileURLToPath(raw, { windows: platform === 'win32' })
    } catch {
      return value
    }
  }
  if (!path.isAbsolute(raw)) return value
  const variants = mappings.flatMap((m) => [
    m,
    ...(m.fromAliases ?? []).map((from) => ({ from, to: m.to }))
  ])
  for (const { from, to } of variants.sort((a, b) => b.from.length - a.from.length)) {
    if (!inside(from, raw, platform)) continue
    const next = path.join(to, path.relative(from, raw))
    return uri ? pathToFileURL(next, { windows: platform === 'win32' }).href : next
  }
  return value
}

export async function assertPlainAncestors(path) {
  let current = resolve(path)
  while (true) {
    const stat = await inspect(current)
    const systemAlias =
      process.platform === 'darwin' &&
      ['/var', '/tmp', '/etc'].includes(current) &&
      stat?.uid === 0 &&
      (await realpath(current)) === `/private${current}`
    if (stat?.isSymbolicLink() && !systemAlias)
      throw new Error(`Unowned symlink in migration root: ${current}`)
    if (stat && !stat.isDirectory() && !systemAlias)
      throw new Error(`Migration root is not a directory: ${current}`)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

// Overrides stay literal. A settings.dataRoot with an exact owned basename is an app-created root;
// renaming arbitrary brand-looking ancestors of a user-selected path is deliberately unsupported.
export async function discover(options) {
  const { home, appData, mode = 'packaged', platform = process.platform } = options
  if (!home || !appData) throw new Error('Explicit absolute home and appData paths are required.')
  const path = platform === 'win32' ? win32 : posix
  for (const p of [
    home,
    appData,
    options.configRoot,
    options.userData,
    options.dataParent,
    options.stateDir,
    options.localAppData,
    ...(options.tempParents ?? []),
    ...(options.maps ?? []).flatMap((m) => [m.from, m.to])
  ].filter((p) => p !== undefined)) {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p) || path.normalize(p) !== p)
      throw new Error(`Expected an absolute path: ${p}`)
  }
  const dev = mode === 'dev'
  if (!dev && mode !== 'packaged') throw new Error('mode must be dev or packaged')
  const configRoot =
    options.configRoot ?? path.join(home, dev ? '.open-science-project' : '.open-science')
  const profileName = dev ? 'Open Science (DEV)' : 'Open Science'
  const userData = options.userData ?? path.join(appData, hyphenateBrand(profileName))
  const mappings = []
  const add = (from, to, kind) => {
    if (from !== to && !mappings.some((m) => m.from === from)) mappings.push({ from, to, kind })
  }
  const dataParent = options.dataParent ?? home
  const dataName = dev ? 'OpenScience-DEV' : 'OpenScience'
  add(path.join(dataParent, dataName), path.join(dataParent, hyphenateBrand(dataName)), 'data')
  if (!options.userData) add(path.join(appData, profileName), userData, 'profile')
  if (platform === 'darwin' && !options.userData) {
    add(
      path.join(home, 'Library', 'Logs', profileName),
      path.join(home, 'Library', 'Logs', hyphenateBrand(profileName)),
      'logs'
    )
  }
  if (platform === 'win32') {
    const local = options.localAppData ?? path.join(home, 'AppData', 'Local')
    add(path.join(local, 'OpenScience'), path.join(local, 'Open-Science'), 'tools')
    add(
      path.join(local, 'Aipoch', 'OpenScience'),
      path.join(local, 'Aipoch', 'Open-Science'),
      'sandbox'
    )
    for (const parent of new Set([path.parse(dataParent).root, ...(options.tempParents ?? [])])) {
      const old = path.join(parent, 'OpenScienceTmp')
      const marker = path.join(old, '.open-science-temp.json')
      if (await inspect(marker)) {
        const value = await readJson(marker)
        if (
          value.schema !== 1 ||
          value.kind !== 'micromamba-working-cache-parent' ||
          typeof value.userIdentity !== 'string'
        )
          throw new Error(`Unrecognized cache ownership: ${old}`)
        add(old, path.join(parent, 'Open-ScienceTmp'), 'working-cache')
      }
    }
  }
  // Inspect casing variants only in the known default parent; never recursively rename user trees.
  for (const [parent, pattern, kind] of [
    [dataParent, dev ? /^open ?science-dev$/i : /^open ?science$/i, 'data'],
    ...(!options.userData
      ? [[appData, dev ? /^open ?science \(DEV\)$/i : /^open ?science$/i, 'profile']]
      : [])
  ]) {
    let names = []
    try {
      names = await readdir(parent)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const name of names)
      if (pattern.test(name)) {
        const from = path.join(parent, name)
        const actual = await inspect(from)
        const aliases = []
        // On case-insensitive volumes the default spelling and readdir spelling name one inode.
        for (let i = mappings.length - 1; i >= 0; i--) {
          const entry = await inspect(mappings[i].from)
          if (entry && actual && entry.dev === actual.dev && entry.ino === actual.ino) {
            aliases.push(mappings[i].from, ...(mappings[i].fromAliases ?? []))
            mappings.splice(i, 1)
          }
        }
        add(from, path.join(parent, hyphenateBrand(name)), kind)
        mappings.find((m) => m.from === from).fromAliases = [
          ...new Set(aliases.filter((a) => a !== from))
        ]
      }
  }
  const settingsFile = join(configRoot, 'settings.json')
  const settings = (await inspect(settingsFile)) ? await readJson(settingsFile) : undefined
  const configured = settings?.dataRoot
  if (
    typeof configured === 'string' &&
    path.isAbsolute(configured) &&
    /^open ?science(?:-DEV)?$/i.test(path.basename(configured))
  ) {
    add(
      configured,
      path.join(path.dirname(configured), hyphenateBrand(path.basename(configured))),
      'configured-data'
    )
  }
  for (const map of options.maps ?? []) add(map.from, map.to, 'explicit')
  // Settings can retain a different spelling for the same case-insensitive filesystem inode.
  // Only coalesce spellings actually proven to resolve to that node; POSIX comparisons stay exact.
  const identities = new Map()
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]
    const stat = await inspect(m.from)
    if (!stat || stat.isSymbolicLink()) continue
    const key = `${stat.dev}:${stat.ino}`
    const prior = identities.get(key)
    if (prior) {
      prior.fromAliases = [
        ...new Set([...(prior.fromAliases ?? []), m.from, ...(m.fromAliases ?? [])])
      ].filter((p) => p !== prior.from)
      mappings.splice(i--, 1)
    } else identities.set(key, m)
  }
  return {
    version: 1,
    home,
    appData,
    mode,
    platform,
    configRoot,
    userData,
    mappings,
    stateDir: options.stateDir ?? `${configRoot}.brand-migration`
  }
}
