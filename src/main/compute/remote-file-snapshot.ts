import { quoteRemotePath } from './remote-path-security'

type RemoteFileSnapshot = Readonly<{
  sizeBytes: number
  inode: string
  mtimeToken: string
}>

type RemoteFileStat = Readonly<{
  fileType: string
  snapshot?: RemoteFileSnapshot
}>

const remoteFileStatCommand = (remotePath: string): string => {
  const quoted = quoteRemotePath(remotePath)
  return [
    `if [ -f ${quoted} ]; then`,
    `  fields=$(LC_ALL=C stat -c '%s %i %Y' ${quoted} 2>/dev/null) || fields=$(LC_ALL=C stat -f '%z %i %m' ${quoted}) || exit 1`,
    `  printf 'f %s\n' "$fields"`,
    `elif [ -d ${quoted} ]; then`,
    `  echo 'd'`,
    `elif [ -e ${quoted} ] || [ -L ${quoted} ]; then`,
    `  echo 'o'`,
    `else`,
    `  echo 'm'`,
    `fi`
  ].join('\n')
}

const normalizeRemoteMtimeToken = (value: string): string | undefined =>
  /^(-?\d+)(?:\.\d+)?$/.exec(value.trim())?.[1]

const parseRemoteFileStat = (stdout: string): RemoteFileStat => {
  const trimmed = stdout.trim()
  const fileType = trimmed[0] ?? '?'
  if (fileType !== 'f') return { fileType }
  const match = /^f\s+(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed)
  if (!match) return { fileType: '?' }
  const sizeBytes = Number.parseInt(match[1]!, 10)
  const mtimeToken = normalizeRemoteMtimeToken(match[3]!)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !mtimeToken) return { fileType: '?' }
  return {
    fileType,
    snapshot: { sizeBytes, inode: match[2]!, mtimeToken }
  }
}

const sameRemoteFileSnapshot = (left: RemoteFileSnapshot, right: RemoteFileSnapshot): boolean =>
  left.sizeBytes === right.sizeBytes &&
  left.inode === right.inode &&
  left.mtimeToken === right.mtimeToken

export {
  normalizeRemoteMtimeToken,
  parseRemoteFileStat,
  remoteFileStatCommand,
  sameRemoteFileSnapshot
}
export type { RemoteFileSnapshot, RemoteFileStat }
