import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseUseCases, USE_CASE_MANIFEST_URL, type UseCase } from '../../shared/use-cases'

// One owner lives for the application process; renderer remounts never retry the network request.
export class UseCaseCatalog {
  private readonly path: string
  private items: UseCase[] = []
  private readonly loaded: Promise<void>
  private refreshed?: Promise<UseCase[]>

  constructor(configRoot: string) {
    this.path = join(configRoot, 'cache', 'use-cases', 'manifest.json')
    this.loaded = readFile(this.path, 'utf8')
      .then((raw) => {
        this.items = parseUseCases(JSON.parse(raw))
      })
      .catch(() => {})
  }

  async cached(): Promise<UseCase[]> {
    await this.loaded
    return this.items
  }

  refresh(): Promise<UseCase[]> {
    return (this.refreshed ??= this.fetchOnce())
  }

  private async fetchOnce(): Promise<UseCase[]> {
    await this.loaded
    try {
      const response = await fetch(USE_CASE_MANIFEST_URL, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) return this.items
      const manifest: unknown = await response.json()
      const next = parseUseCases(manifest)
      this.items = next
      // Publish only validated complete manifests, leaving the previous cache intact on failure.
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(`${this.path}.tmp`, JSON.stringify(manifest), { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    } catch {
      // Catalog availability must not interrupt the home page or a running import.
    }
    return this.items
  }
}
