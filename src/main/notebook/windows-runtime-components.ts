import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export type WindowsRuntimeComponent = 'node' | 'powershell'

// This catalog ships with the application. A mutable remote manifest is not a trust anchor.
// Official entries are added only after the same native isolation suite as patched entries passes.
export type WindowsRuntimeComponentRelease = Readonly<{
  component: WindowsRuntimeComponent
  version: string
  architecture: 'x64' | 'arm64'
  source: 'official' | 'patched'
  archive: Readonly<{ url: string; sha256: string; size: number }>
  files: Readonly<Record<string, string>>
}>

export type WindowsRuntimeComponentSelection = Readonly<{
  release: WindowsRuntimeComponentRelease
  root: string
  executable: string
}>

export type WindowsRuntimeComponentProgress = Readonly<{
  component: WindowsRuntimeComponent
  phase: 'checking' | 'downloading' | 'verifying'
  received?: number
  total?: number
}>

export type WindowsRuntimeComponentDependencies = Readonly<{
  download: (
    release: WindowsRuntimeComponentRelease,
    archivePath: string,
    signal?: AbortSignal,
    progress?: (received: number, total?: number) => void
  ) => Promise<void>
  extract: (archivePath: string, destination: string) => Promise<void>
  // Uses the actual AppContainer with a deadline and verified process-tree cleanup.
  probe: (selection: WindowsRuntimeComponentSelection, signal?: AbortSignal) => Promise<void>
}>

// Only a failed compatibility check with confirmed cleanup permits trying another candidate.
export class WindowsRuntimeIncompatibleError extends Error {}

const digestPattern = /^[a-f0-9]{64}$/
const executableName = (component: WindowsRuntimeComponent): string =>
  component === 'node' ? 'node.exe' : 'pwsh.exe'

const safeRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes('\\') &&
  ![...path].some((character) => character.charCodeAt(0) < 32 || character === ':') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

export const assertWindowsRuntimeComponentRelease = (
  release: WindowsRuntimeComponentRelease
): void => {
  const url = new URL(release.archive.url)
  if (
    !['node', 'powershell'].includes(release.component) ||
    !['official', 'patched'].includes(release.source) ||
    !['x64', 'arm64'].includes(release.architecture) ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    url.origin !== 'https://statics.aipoch.com' ||
    !url.pathname.startsWith('/open-science/notebook-runtime/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !digestPattern.test(release.archive.sha256) ||
    !Number.isSafeInteger(release.archive.size) ||
    release.archive.size <= 0 ||
    release.archive.size > 1024 ** 3 ||
    !release.files[executableName(release.component)] ||
    Object.entries(release.files).some(
      ([path, digest]) => !safeRelativePath(path) || !digestPattern.test(digest)
    )
  ) {
    throw new Error('Invalid Windows runtime component catalog entry.')
  }
}

const sha256 = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// Reject extra files too: an unlisted DLL or startup module may change executable behavior.
// Every path is inspected without following symlinks/junctions, including intermediate directories.
export const verifyWindowsRuntimeComponent = async (
  release: WindowsRuntimeComponentRelease,
  root: string,
  signal?: AbortSignal
): Promise<void> => {
  assertWindowsRuntimeComponentRelease(release)
  const pending = new Set(Object.keys(release.files))
  const visit = async (directory: string, relative: string): Promise<void> => {
    signal?.throwIfAborted()
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Windows runtime directory must not be a link.')
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file, path)
      else {
        signal?.throwIfAborted()
        if (
          !entry.isFile() ||
          !pending.delete(path) ||
          (await sha256(file)) !== release.files[path]
        ) {
          throw new Error(`Windows runtime component integrity check failed: ${path}`)
        }
      }
    }
  }
  await visit(root, '')
  if (pending.size) throw new Error('Windows runtime component is incomplete.')
}

export class WindowsRuntimeComponentStore {
  private readonly preparing = new Map<string, Promise<WindowsRuntimeComponentSelection>>()

  constructor(
    private readonly root: string,
    private readonly deps: WindowsRuntimeComponentDependencies
  ) {
    if (!isAbsolute(root)) throw new Error('Windows runtime storage requires an absolute path.')
  }

  // Selection is explicit. Only Setup may pass allowDownload; startup and execution stay offline.
  async select(
    releases: readonly WindowsRuntimeComponentRelease[],
    request: Readonly<{
      component: WindowsRuntimeComponent
      architecture: string
      officialRoots: readonly string[]
      bundledRoots?: readonly string[]
      allowDownload: boolean
      signal?: AbortSignal
      onProgress?: (progress: WindowsRuntimeComponentProgress) => void
    }>
  ): Promise<WindowsRuntimeComponentSelection> {
    request.signal?.throwIfAborted()
    const candidates = releases.filter(
      (release) =>
        release.component === request.component && release.architecture === request.architecture
    )
    for (const release of candidates) assertWindowsRuntimeComponentRelease(release)
    request.onProgress?.({ component: request.component, phase: 'checking' })
    // Candidate roots come from the application installation inventory, never workspace PATH.
    for (const release of candidates.filter((entry) => entry.source === 'official')) {
      for (const root of request.officialRoots) {
        if (!isAbsolute(root)) continue
        const selection = await this.tryVerified(release, root, request.signal, true)
        if (selection) return selection
      }
    }
    for (const release of candidates) {
      for (const root of request.bundledRoots ?? []) {
        if (!isAbsolute(root)) continue
        const selection = await this.tryVerified(release, root, request.signal, true)
        if (selection) return selection
      }
      const selection = await this.tryVerified(
        release,
        this.destination(release),
        request.signal,
        false
      )
      if (selection) return selection
    }
    if (!request.allowDownload || candidates.length === 0) {
      throw new Error(
        `Windows ${request.component} runtime is not ready. Prepare protected mode in Settings.`
      )
    }
    const release = candidates[0]!
    const key = this.destination(release)
    const pending = this.preparing.get(key)
    if (pending) {
      const result = await pending
      request.signal?.throwIfAborted()
      return result
    }
    const operation = this.install(release, request)
    this.preparing.set(key, operation)
    try {
      return await operation
    } finally {
      this.preparing.delete(key)
    }
  }

  private destination(release: WindowsRuntimeComponentRelease): string {
    return join(this.root, release.component, release.architecture, release.archive.sha256)
  }

  private async tryVerified(
    release: WindowsRuntimeComponentRelease,
    root: string,
    signal?: AbortSignal,
    skipIncompatible = true
  ): Promise<WindowsRuntimeComponentSelection | undefined> {
    try {
      await verifyWindowsRuntimeComponent(release, root, signal)
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
    const selection = { release, root, executable: join(root, executableName(release.component)) }
    try {
      await this.deps.probe(selection, signal)
      signal?.throwIfAborted()
      return selection
    } catch (error) {
      signal?.throwIfAborted()
      if (skipIncompatible && error instanceof WindowsRuntimeIncompatibleError) return undefined
      throw error
    }
  }

  private async install(
    release: WindowsRuntimeComponentRelease,
    request: Readonly<{
      signal?: AbortSignal
      onProgress?: (progress: WindowsRuntimeComponentProgress) => void
    }>
  ): Promise<WindowsRuntimeComponentSelection> {
    const destination = this.destination(release)
    const parent = resolve(destination, '..')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const directory of [this.root, join(this.root, release.component), parent]) {
      if (directory !== this.root) {
        try {
          await mkdir(directory, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Windows runtime storage must not contain a linked directory.')
      }
    }
    // Never overwrite or delete an existing component: another app/kernel may still use it.
    // A corrupt existing version is a repair operation, not permission to erase an active runtime.
    try {
      await lstat(destination)
      throw new Error('The cached Windows runtime requires repair. Existing files were preserved.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const staging = await mkdtemp(join(parent, '.prepare-'))
    try {
      const archivePath = join(staging, 'component.tar.zst')
      request.onProgress?.({ component: release.component, phase: 'downloading' })
      await this.deps.download(release, archivePath, request.signal, (received, total) =>
        request.onProgress?.({
          component: release.component,
          phase: 'downloading',
          received,
          total
        })
      )
      request.signal?.throwIfAborted()
      if (
        (await lstat(archivePath)).size !== release.archive.size ||
        (await sha256(archivePath)) !== release.archive.sha256
      )
        throw new Error('Windows runtime archive integrity check failed.')
      const extracted = join(staging, 'runtime')
      await mkdir(extracted)
      request.onProgress?.({ component: release.component, phase: 'verifying' })
      await this.deps.extract(archivePath, extracted)
      await verifyWindowsRuntimeComponent(release, extracted, request.signal)
      request.signal?.throwIfAborted()
      await rename(extracted, destination)
      const selection = {
        release,
        root: destination,
        executable: join(destination, executableName(release.component))
      }
      // Probe the final path: ACLs and module discovery depend on its actual ancestors.
      await this.deps.probe(selection, request.signal)
      request.signal?.throwIfAborted()
      return selection
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
