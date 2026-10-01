import { join } from 'node:path'
import catalog from './windows-runtime-catalog.json'
import { extractPackArchive } from './pack-archive'
import { resilientDownload } from '../net/resilient-download'
import { netFetchStandard } from '../skills/net-fetch'
import {
  WindowsRuntimeComponentStore,
  assertWindowsRuntimeComponentRelease,
  verifyWindowsRuntimeComponent,
  type WindowsRuntimeComponentDependencies,
  type WindowsRuntimeComponentProgress,
  type WindowsRuntimeComponentRelease,
  type WindowsRuntimeComponentSelection
} from './windows-runtime-components'
import type { WindowsNotebookRuntime } from './windows-notebook-runtime'

export class WindowsNotebookRuntimeManager {
  private readonly store: WindowsRuntimeComponentStore
  private selected?: WindowsNotebookRuntime
  private protectedReady = false
  private officialSelections: WindowsRuntimeComponentSelection[] = []
  private pending?: Promise<WindowsNotebookRuntime>
  progress?: WindowsRuntimeComponentProgress

  constructor(
    private readonly root: string,
    probe: WindowsRuntimeComponentDependencies['probe'],
    private readonly releases = catalog.releases as unknown as readonly WindowsRuntimeComponentRelease[],
    private readonly architecture: string = process.arch
  ) {
    if (catalog.schema !== 1) throw new Error('Unsupported Windows runtime catalog schema.')
    releases.forEach(assertWindowsRuntimeComponentRelease)
    if (
      releases.some(
        (release) => release.component === 'powershell' && !release.version.startsWith('7.6.')
      )
    ) {
      throw new Error('A new PowerShell minor version requires explicit Session binding support.')
    }
    this.store = new WindowsRuntimeComponentStore(root, {
      probe,
      extract: extractPackArchive,
      download: async (release, path, signal, progress) => {
        await resilientDownload(release.archive.url, path, {
          expectedSha256: release.archive.sha256,
          expectedSize: release.archive.size,
          signal,
          stallTimeoutMs: 60_000,
          onProgress: (value) => progress?.(value.transferred, value.total),
          deps: { fetchImpl: netFetchStandard }
        })
      }
    })
  }

  get(): WindowsNotebookRuntime {
    if (!this.selected) {
      throw new Error('Windows Notebook runtime is not ready. Prepare protected mode in Settings.')
    }
    return this.selected
  }

  getProtected(): WindowsNotebookRuntime {
    if (!this.protectedReady)
      throw new Error('Windows runtime protection verification is required.')
    return this.get()
  }

  async prepare(
    allowDownload: boolean,
    signal?: AbortSignal,
    mode: 'protected' | 'standard' = 'protected'
  ): Promise<WindowsNotebookRuntime> {
    signal?.throwIfAborted()
    if (mode === 'standard' && allowDownload)
      throw new Error('Standard mode does not download runtime components.')
    // Managed components are immutable and read-only to Notebook processes. Official installations
    // can be updated externally, so check their bytes before reusing a previous compatibility result.
    if (this.selected && (mode === 'standard' || this.protectedReady)) {
      try {
        for (const selection of this.officialSelections)
          await verifyWindowsRuntimeComponent(selection.release, selection.root, signal)
        return this.selected
      } catch {
        signal?.throwIfAborted()
        this.selected = undefined
        this.protectedReady = false
      }
    }
    if (this.pending) {
      const runtime = await this.pending
      signal?.throwIfAborted()
      if (mode === 'protected' && !this.protectedReady)
        return this.prepare(allowDownload, signal, mode)
      return runtime
    }
    const operation = this.prepareComponents(allowDownload, signal, mode)
    this.pending = operation
    try {
      return await operation
    } finally {
      this.pending = undefined
      this.progress = undefined
    }
  }

  private async prepareComponents(
    allowDownload: boolean,
    signal: AbortSignal | undefined,
    mode: 'protected' | 'standard'
  ): Promise<WindowsNotebookRuntime> {
    const paths: Partial<Record<'node' | 'powershell', string>> = {}
    const officialSelections: WindowsRuntimeComponentSelection[] = []
    for (const component of ['node', 'powershell'] as const) {
      // Only known installation locations are inventoried. An arbitrary workspace PATH entry is
      // never executed to discover its version. Exact official file inventories come from catalog.
      const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles
      const officialRoots = programFiles
        ? [join(programFiles, component === 'node' ? 'nodejs' : 'PowerShell/7')]
        : []
      const selection = await this.store.select(this.releases, {
        component,
        architecture: this.architecture,
        officialRoots,
        bundledRoots: process.resourcesPath
          ? [join(process.resourcesPath, 'notebook-runtime', this.architecture, component)]
          : [],
        allowDownload,
        verifyCompatibility: mode === 'protected',
        signal,
        onProgress: (progress) => {
          this.progress = progress
        }
      })
      paths[component] = selection.executable
      if (selection.release.source === 'official') officialSelections.push(selection)
    }
    signal?.throwIfAborted()
    this.officialSelections = officialSelections
    this.protectedReady = mode === 'protected'
    this.selected = Object.freeze({
      root: this.root,
      node: paths.node!,
      powershell: paths.powershell!
    })
    return this.selected
  }
}
