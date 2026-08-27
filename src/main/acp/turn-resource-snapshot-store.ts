import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

type TurnResourceSnapshotSource = Readonly<{
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
}>

type TurnResourceSnapshot = Readonly<{
  absolutePath: string
  uri: string
}>

type TurnResourceSnapshotStoreOptions = Readonly<{
  temporaryRoot?: string
  createId?: () => string
  removeDirectory?: typeof rmSync
}>

const safeExtension = (name: string): string => {
  const extension = extname(name)
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : ''
}

class TurnResourceSnapshotStore {
  private rootPath: string | undefined
  private closed = false
  private readonly createId: () => string
  private readonly removeDirectory: typeof rmSync

  constructor(private readonly options: TurnResourceSnapshotStoreOptions = {}) {
    this.createId = options.createId ?? randomUUID
    this.removeDirectory = options.removeDirectory ?? rmSync
  }

  async create(name: string, source: TurnResourceSnapshotSource): Promise<TurnResourceSnapshot> {
    if (this.closed) throw new Error('Turn resource snapshot store is closed.')

    try {
      const rootPath = await this.ensureRoot()
      const absolutePath = join(rootPath, `${this.createId()}${safeExtension(name)}`)
      await source.copyTo(absolutePath, { exclusive: true })
      await chmod(absolutePath, 0o600)
      return Object.freeze({ absolutePath, uri: pathToFileURL(absolutePath).href })
    } catch (error) {
      try {
        this.close()
      } catch {
        // Snapshot creation failure is authoritative; cleanup is best-effort.
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const rootPath = this.rootPath
    this.rootPath = undefined
    if (rootPath) this.removeDirectory(rootPath, { recursive: true, force: true })
  }

  private async ensureRoot(): Promise<string> {
    if (this.rootPath) return this.rootPath
    const rootPath = await mkdtemp(
      join(this.options.temporaryRoot ?? tmpdir(), 'open-science-acp-turn-')
    )
    this.rootPath = rootPath
    await chmod(rootPath, 0o700)
    return rootPath
  }
}

export { TurnResourceSnapshotStore }
