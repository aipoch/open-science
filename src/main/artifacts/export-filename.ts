import { basename } from 'node:path'

export const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu
export const outputFilename = (path: string): string => {
  const name = basename(path.replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
    .replace(/^[. ]+|[. ]+$/gu, '')
  return !name || WINDOWS_RESERVED_BASENAME.test(name.split('.')[0]!)
    ? 'reproduced-output.bin'
    : name
}
