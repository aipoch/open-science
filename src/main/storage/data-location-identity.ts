import { realpathSync, statSync } from 'node:fs'

type LocationIdentityDependencies = {
  platform?: NodeJS.Platform
  stat: (root: string) => { dev: bigint; ino: bigint }
  realpath: (root: string) => string
}

// Some filesystems do not expose usable inode numbers. Zero is an unavailable identity,
// never evidence that two data directories are the same. Preserve exact canonical case:
// Windows supports case-sensitive directories too, so lowercasing can hide distinct data.
export const dataLocationIdentity = (
  root: string,
  dependencies: LocationIdentityDependencies = {
    stat: (path) => statSync(path, { bigint: true }),
    realpath: (path) => realpathSync.native(path)
  }
): string => {
  // Windows file indexes (notably ReFS) are not a portable unique directory identity.
  if ((dependencies.platform ?? process.platform) === 'win32')
    return `path:${dependencies.realpath(root)}`
  const info = dependencies.stat(root)
  return info.ino > 0n ? `inode:${info.dev}:${info.ino}` : `path:${dependencies.realpath(root)}`
}
