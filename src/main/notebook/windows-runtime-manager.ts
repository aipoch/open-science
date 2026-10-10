import { runtimeMetadata } from '../runtime-metadata'
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
  private officialSelections: WindowsRuntimeComponentSelection[] = []
  private pending?: Promise<WindowsNotebookRuntime>
  progress?: WindowsRuntimeComponentProgress
  failure?: Pick<WindowsRuntimeComponentProgress, 'component' | 'phase'>

  get downloadBytes(): number {
    return (['node', 'powershell'] as const).reduce(
      (total, component) =>
        total +
        Math.max(
          0,
          ...this.releases
            .filter(
              (release) =>
                release.component === component && release.architecture === this.architecture
            )
            .map((release) => release.archive.size)
        ),
      0
    )
  }

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
          onProgress: (value) => progress?.(value.transferred, value.total, value),
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

  async prepare(allowDownload: boolean, signal?: AbortSignal): Promise<WindowsNotebookRuntime> {
    signal?.throwIfAborted()
    // Managed components are immutable and read-only to Notebook processes. Official installations
    // can be updated externally, so check their bytes before reusing a previous compatibility result.
    if (this.selected) {
      try {
        for (const selection of this.officialSelections)
          await verifyWindowsRuntimeComponent(selection.release, selection.root, signal)
        return this.selected
      } catch {
        signal?.throwIfAborted()
        this.selected = undefined
      }
    }
    if (this.pending) {
      const runtime = await this.pending
      signal?.throwIfAborted()
      return runtime
    }
    this.failure = undefined
    const operation = this.prepareComponents(allowDownload, signal)
    this.pending = operation
    try {
      return await operation
    } catch (error) {
      if (this.progress)
        this.failure = { component: this.progress.component, phase: this.progress.phase }
      throw error
    } finally {
      this.pending = undefined
      this.progress = undefined
    }
  }

  private async prepareComponents(
    allowDownload: boolean,
    signal: AbortSignal | undefined
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
        bundledRoots: runtimeMetadata().resourcesPath
          ? [
              join(
                runtimeMetadata().resourcesPath,
                'notebook-runtime',
                this.architecture,
                component
              )
            ]
          : [],
        allowDownload,
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
    this.selected = Object.freeze({
      root: this.root,
      node: paths.node!,
      powershell: paths.powershell!
    })
    return this.selected
  }
}
