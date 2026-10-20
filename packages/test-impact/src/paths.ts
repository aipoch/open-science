import path from 'node:path'

export function assertPortablePaths(files: string[]): void {
  const names = new Map<string, string>()
  for (const file of files) {
    const parts = file.split('/')
    if (
      !file ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[\\<>:"|?*]/u.test(part) ||
          /[ .]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part) ||
          ['.git', 'node_modules'].includes(part.toLowerCase())
      )
    ) {
      throw new Error(`Nonportable or reserved snapshot path: ${JSON.stringify(file)}`)
    }
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/')
      const key = prefix.normalize('NFC').toLowerCase()
      const previous = names.get(key)
      if (previous && previous !== prefix)
        throw new Error(`Snapshot path collision: ${previous}, ${prefix}`)
      names.set(key, prefix)
    }
  }
}

export function isInside(root: string, target: string, api = path): boolean {
  const relative = api.relative(root, target)
  return (
    relative === '' ||
    (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`))
  )
}
