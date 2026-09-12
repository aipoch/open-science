import { extname, resolve } from 'node:path'
import { parseWebModeOptions } from '../web-service/options'

// Installed file associations forward local paths, never URLs or shell command strings.
export const packagePathsFromArgv = (argv: string[], cwd: string): string[] => {
  if (parseWebModeOptions(argv, {}).enabled) return []
  return argv
    .slice(1)
    .filter(
      (arg) =>
        !arg.startsWith('-') && !arg.includes('://') && extname(arg).toLowerCase() === '.science'
    )
    .map((arg) => resolve(cwd, arg))
}

// Listen before Electron ready, but defer all application work until runtime ownership is installed.
export class PackageFileOpenRelay {
  private pending = new Set<string>()
  private handler?: (path: string) => void
  private overflow = false

  constructor(private readonly onOverflow: () => void) {}

  receive(path: string): void {
    if (extname(path).toLowerCase() !== '.science') return
    if (this.handler) this.handler(path)
    else if (this.pending.has(path)) return
    else if (this.pending.size < 16) this.pending.add(path)
    else this.overflow = true
  }

  bind(handler: (path: string) => void): void {
    this.handler = handler
    for (const path of this.pending) handler(path)
    this.pending.clear()
    if (this.overflow) {
      this.overflow = false
      this.onOverflow()
    }
  }
}
