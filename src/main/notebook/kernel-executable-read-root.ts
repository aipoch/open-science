import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'

/** Shared read boundary for kernel and package-installer executables. */
export const kernelExecutableReadRoot = (
  executable: string,
  kind: NotebookLanguage | 'repl',
  platform: NodeJS.Platform
): string => {
  const platformPath = platform === 'win32' ? win32 : posix
  if (kind === 'repl' && platform === 'darwin' && executable.includes('/Contents/MacOS/')) {
    return platformPath.resolve(platformPath.dirname(executable), '../..')
  }
  if (kind === 'r' && platform === 'win32' && /^Rscript\.exe$/i.test(win32.basename(executable))) {
    const directory = win32.dirname(executable)
    const bin =
      win32.basename(directory).toLowerCase() === 'x64' ? win32.dirname(directory) : directory
    const home = win32.dirname(bin)
    if (
      win32.basename(bin).toLowerCase() === 'bin' &&
      existsSync(win32.join(home, 'etc')) &&
      existsSync(win32.join(home, 'library'))
    ) {
      return home
    }
  }
  return platformPath.dirname(executable)
}
