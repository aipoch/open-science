// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistMarketplace } from './SpecialistMarketplace'
import { resetMarketplaceStoreForTests } from '../../stores/marketplace-store'
import type { MarketplaceSnapshot } from '../../../../shared/specialist-marketplace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const deferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  return {
    promise: new Promise<Value>((done, fail) => {
      resolve = done
      reject = fail
    }),
    resolve,
    reject
  }
}

const snapshot = {
  sources: [
    {
      id: 'github-example',
      kind: 'github' as const,
      name: 'Example Marketplace',
      repositoryUrl: 'https://github.com/example/marketplace',
      ref: 'main',
      trust: 'user-approved' as const,
      keyId: 'example-2026-01',
      keyFingerprint: 'a'.repeat(64),
      removable: true
    }
  ],
  specialists: [
    {
      sourceId: 'github-example',
      sourceName: 'Example Marketplace',
      sourceTrust: 'user-approved' as const,
      id: 'example-specialist',
      displayName: 'Example Specialist',
      summary: 'Focused research workflows.',
      publisher: { id: 'example', name: 'Example Publisher' },
      version: '1.0.0'
    }
  ],
  failures: []
}

const release = {
  sourceId: 'github-example',
  specialistId: 'example-specialist',
  displayName: 'Example Specialist',
  summary: 'Focused research workflows.',
  publisher: { id: 'example', name: 'Example Publisher' },
  version: '2.0.0',
  repository: 'https://github.com/example/upstream',
  commit: 'a'.repeat(40),
  license: 'MIT',
  compressedBytes: 100,
  uncompressedBytes: 200,
  fileCount: 2,
  defaultSkillIds: [],
  defaultConnectorIds: [],
  skills: [],
  connectors: []
}

beforeEach(() => {
  // The Marketplace snapshot is module-level store state shared across renders; each case starts
  // from a pristine store so view-entry behavior (loading vs instant stale content) is hermetic.
  resetMarketplaceStoreForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.api = {
    specialist: {
      listMarketplace: vi.fn().mockResolvedValue(snapshot),
      inspectGitHubMarketplaceSource: vi.fn().mockResolvedValue({
        candidateToken: 'candidate',
        repositoryUrl: 'https://github.com/example/marketplace',
        ref: 'main',
        marketplaceId: 'example',
        name: 'Example Marketplace',
        keyId: 'example-2026-01',
        keyFingerprint: 'a'.repeat(64),
        specialistCount: 1
      }),
      addMarketplaceSource: vi.fn().mockResolvedValue(snapshot.sources[0]),
      cancelMarketplaceCandidate: vi.fn().mockResolvedValue(undefined),
      removeMarketplaceSource: vi.fn()
    }
  } as never
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Specialist Marketplace settings', () => {
  it('animates loading and shows a retryable error when every source is unavailable', async () => {
    const pending = deferred<MarketplaceSnapshot>()
    window.api.specialist.listMarketplace = vi.fn().mockReturnValueOnce(pending.promise)

    act(() => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    })

    const loading = container.querySelector('[role="status"]')
    expect(loading?.textContent).toContain('Loading Marketplace…')
    expect(loading?.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      pending.resolve({
        sources: snapshot.sources,
        specialists: [],
        failures: [
          {
            sourceId: 'github-example',
            sourceName: 'Example Marketplace',
            code: 'network',
            message: 'CDN and GitHub are unavailable.'
          }
        ]
      })
      await pending.promise
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Marketplace could not be reached from any configured source.'
    )
    window.api.specialist.listMarketplace = vi.fn().mockResolvedValue(snapshot)
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Retry')
        )!
      )
    })
    expect(container.textContent).toContain('Example Specialist')
  })

  it('loads remote listings without registering their Skills and opens one Specialist detail', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={onNavigate} />)
    })

    expect(container.querySelector('h2')?.textContent).toBe('Marketplace')
    expect(container.textContent).toContain(
      'Browse and install Specialists from configured sources.'
    )
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.textContent).toContain('Example Specialist')
    expect(container.textContent).toContain('Community')
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    const listing = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Example Specialist')
    )
    fireEvent.click(listing!)
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'marketplace-release',
      sourceId: 'github-example',
      sourceName: 'Example Marketplace',
      sourceTrust: 'user-approved',
      id: 'example-specialist',
      version: '1.0.0',
      installedVersion: undefined,
      updateAvailable: undefined
    })
  })

  it('keeps the current listings visible while a manual refresh retries the latest data', async () => {
    const refresh = deferred<MarketplaceSnapshot>()
    window.api.specialist.listMarketplace = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(refresh.promise)

    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    })

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh Marketplace"]'
    )
    await act(async () => {
      fireEvent.click(refreshButton!)
      await Promise.resolve()
    })
    expect(refreshButton?.disabled).toBe(true)
    expect(container.textContent).toContain('Example Specialist')

    await act(async () => {
      refresh.reject(new Error('offline'))
      await refresh.promise.catch(() => undefined)
    })
    expect(refreshButton?.disabled).toBe(false)
    expect(container.textContent).toContain('Example Specialist')
    expect(container.textContent).toContain(
      'Could not refresh Marketplace. Showing the last available data.'
    )
  })

  it('shows the last listings immediately with a visible refresh when returning from a release', async () => {
    const refresh = deferred<MarketplaceSnapshot>()
    window.api.specialist.listMarketplace = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(refresh.promise)
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)

    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    })
    expect(container.textContent).toContain('Example Specialist')

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })
    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Re-entering keeps the last snapshot on screen instead of a full-screen loader, with a
    // status line making the in-flight refresh visible.
    expect(container.textContent).not.toContain('Loading Marketplace…')
    expect(container.textContent).toContain('Example Specialist')
    expect(container.textContent).toContain('Refreshing Marketplace…')

    await act(async () => {
      refresh.resolve(snapshot)
      await refresh.promise
    })
    expect(container.textContent).not.toContain('Refreshing Marketplace…')
  })

  it('labels the data age once a refresh settles', async () => {
    window.api.specialist.listMarketplace = vi.fn().mockResolvedValue({
      ...snapshot,
      sources: [{ ...snapshot.sources[0], lastRefreshedAt: '2026-08-19T00:00:00.000Z' }]
    })

    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toMatch(/Updated /)
  })

  it('shows signing identity before a GitHub source can be trusted and added', async () => {
    await act(async () => {
      root.render(
        <SpecialistMarketplace view={{ kind: 'marketplace-sources' }} onNavigate={vi.fn()} />
      )
    })

    const input = container.querySelector<HTMLInputElement>('#marketplace-repository')!
    fireEvent.change(input, { target: { value: 'https://github.com/example/marketplace' } })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Inspect source')
        )!
      )
    })

    expect(container.textContent).toContain('Signing key fingerprint')
    expect(container.textContent).toContain('a'.repeat(64))

    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Trust and add source')
        )!
      )
    })
    expect(window.api.specialist.addMarketplaceSource).toHaveBeenCalledWith({
      candidateToken: 'candidate'
    })
  })

  it('uses the shared tooltip-backed danger action for source removal', async () => {
    await act(async () => {
      root.render(
        <SpecialistMarketplace view={{ kind: 'marketplace-sources' }} onNavigate={vi.fn()} />
      )
    })

    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Example Marketplace"]'
    )
    expect(remove?.getAttribute('data-state')).toBe('closed')
    expect(remove?.className).toContain('hover:text-destructive')
  })

  it('opens an installed Marketplace Specialist instead of starting another install', async () => {
    const onNavigate = vi.fn()
    window.api.specialist.listMarketplace = vi.fn().mockResolvedValue({
      ...snapshot,
      specialists: [{ ...snapshot.specialists[0], installedVersion: '1.0.0' }]
    })

    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={onNavigate} />)
    })

    expect(container.textContent).toContain('Installed')
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Manage'
      )!
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'example-specialist' })
  })

  it('keeps capability details collapsed while allowing every optional Skill to remain deselected', async () => {
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue({
      ...release,
      skills: [
        {
          id: 'example-skill',
          name: 'example-skill',
          displayName: 'Example Skill',
          description: 'Optional workflow.',
          fileCount: 1,
          uncompressedBytes: 100
        }
      ]
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('0 of 1 included')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    const skills = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Skills')
    )
    const connectors = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Connectors')
    )
    expect(skills?.querySelector('.lucide-scroll-text')).not.toBeNull()
    expect(connectors?.querySelector('svg > rect[x="14.5"]')).not.toBeNull()
    expect(skills?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(skills!)
    expect(skills?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Install Specialist')
      )?.disabled
    ).toBe(false)
  })

  it('labels verified cached Marketplace data without hiding its listings', async () => {
    window.api.specialist.listMarketplace = vi.fn().mockResolvedValue({
      ...snapshot,
      sources: [
        {
          ...snapshot.sources[0],
          lastRefreshedAt: '2026-08-18T00:00:00.000Z',
          usingCachedMetadata: true
        }
      ]
    })

    await act(async () => {
      root.render(<SpecialistMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('Showing verified cached data')
    expect(container.textContent).toContain('Example Marketplace')
    expect(container.textContent).toContain('Example Specialist')
  })

  it('pauses an update only when replacing local changes needs confirmation', async () => {
    const onNavigate = vi.fn()
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)
    window.api.specialist.prepareMarketplaceInstall = vi.fn().mockResolvedValue({
      release: {},
      package: {
        candidateToken: 'update-candidate',
        diagnostics: [],
        installable: true,
        overwrite: {
          id: 'example-specialist',
          target: 'custom',
          currentVersion: '1.0.0',
          incomingVersion: '2.0.0',
          modifiedSinceImport: true,
          hasImportBaseline: true
        }
      }
    })
    window.api.specialist.installMarketplace = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'example-specialist' }
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0',
            installedVersion: '1.0.0',
            updateAvailable: true
          }}
          onNavigate={onNavigate}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Update Specialist')
        )!
      )
    })
    expect(window.api.specialist.installMarketplace).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Package verified')
    expect(container.textContent).toContain('Resolve the items below')
    expect(container.textContent).toContain('Update from v1.0.0 to v2.0.0')
    expect(container.textContent).toContain('Local changes')
    expect(container.textContent).not.toContain('Back to Marketplace')
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Replace local changes')
        )!
      )
    })
    expect(window.api.specialist.installMarketplace).toHaveBeenCalledWith({
      candidateToken: 'update-candidate',
      confirmOverwrite: true,
      skillConflictResolutions: []
    })
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
  })

  it('discards a prepared candidate when capability selections change', async () => {
    const releaseWithSkill = {
      ...release,
      defaultSkillIds: ['analysis-skill'],
      skills: [
        {
          id: 'analysis-skill',
          displayName: 'Analysis Skill',
          description: 'Analyzes research evidence.'
        }
      ]
    }
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(releaseWithSkill)
    window.api.specialist.prepareMarketplaceInstall = vi
      .fn()
      .mockResolvedValueOnce({
        release: releaseWithSkill,
        package: {
          candidateToken: 'stale-candidate',
          diagnostics: [],
          installable: true,
          overwrite: {
            id: 'example-specialist',
            target: 'custom',
            currentVersion: '1.0.0',
            incomingVersion: '2.0.0',
            modifiedSinceImport: true,
            hasImportBaseline: true
          }
        }
      })
      .mockResolvedValueOnce({
        release: releaseWithSkill,
        package: { candidateToken: 'fresh-candidate', diagnostics: [], installable: true }
      })
    window.api.specialist.installMarketplace = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'example-specialist' }
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
    })
    expect(container.textContent).toContain('Replace local changes')

    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Skills')
      )!
    )
    fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!)

    expect(window.api.specialist.cancelMarketplaceCandidate).toHaveBeenCalledWith({
      candidateToken: 'stale-candidate'
    })
    expect(container.textContent).not.toContain('Replace local changes')

    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
    })

    expect(window.api.specialist.prepareMarketplaceInstall).toHaveBeenNthCalledWith(1, {
      sourceId: 'github-example',
      specialistId: 'example-specialist',
      version: '2.0.0',
      selectedSkillIds: ['analysis-skill'],
      selectedConnectorIds: []
    })
    expect(window.api.specialist.prepareMarketplaceInstall).toHaveBeenNthCalledWith(2, {
      sourceId: 'github-example',
      specialistId: 'example-specialist',
      version: '2.0.0',
      selectedSkillIds: [],
      selectedConnectorIds: []
    })
    expect(window.api.specialist.installMarketplace).toHaveBeenCalledWith({
      candidateToken: 'fresh-candidate',
      skillConflictResolutions: []
    })
  })

  it('does not present a provenance-pending installation as fully complete', async () => {
    const onNavigate = vi.fn()
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)
    window.api.specialist.prepareMarketplaceInstall = vi.fn().mockResolvedValue({
      release,
      package: { candidateToken: 'pending-provenance', diagnostics: [], installable: true }
    })
    window.api.specialist.installMarketplace = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'example-specialist' },
      provenanceLinked: false
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={onNavigate}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
    })

    expect(onNavigate).not.toHaveBeenCalled()
    expect(container.textContent).toContain(
      'This Specialist was installed, but Marketplace status is still being recovered.'
    )
    expect(container.textContent).not.toContain('Package verified')
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Back to Marketplace')
      )!
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'marketplace' })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'another-specialist',
            version: '1.0.0'
          }}
          onNavigate={onNavigate}
        />
      )
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('Marketplace status is still being recovered.')
  })

  it('requires a fresh download after an installation attempt consumes its candidate', async () => {
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)
    window.api.specialist.prepareMarketplaceInstall = vi.fn().mockResolvedValue({
      release,
      package: { candidateToken: 'consumed-candidate', diagnostics: [], installable: true }
    })
    window.api.specialist.installMarketplace = vi.fn().mockResolvedValue({
      status: 'failed',
      code: 'commit-failed'
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
    })

    expect(container.textContent).toContain('Installation failed. Try again.')
    expect(container.textContent).not.toContain('Package verified')
    expect(container.textContent).toContain('Install Specialist')
    expect(window.api.specialist.cancelMarketplaceCandidate).toHaveBeenCalledWith({
      candidateToken: 'consumed-candidate'
    })
  })

  it('shows streamed package download progress while preparing an install', async () => {
    const prepared =
      deferred<Awaited<ReturnType<typeof window.api.specialist.prepareMarketplaceInstall>>>()
    let reportProgress:
      Parameters<typeof window.api.specialist.onMarketplaceDownloadProgress>[0] | undefined
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)
    window.api.specialist.onMarketplaceDownloadProgress = vi.fn((listener) => {
      reportProgress = listener
      return vi.fn()
    })
    window.api.specialist.prepareMarketplaceInstall = vi.fn().mockReturnValue(prepared.promise)
    window.api.specialist.installMarketplace = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'example-specialist' },
      provenanceLinked: true
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
      await Promise.resolve()
    })

    const progress = container.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('data-indeterminate')).toBe('true')

    await act(async () => {
      reportProgress?.({
        sourceId: 'github-example',
        specialistId: 'example-specialist',
        version: '2.0.0',
        transferred: 50,
        total: 100,
        percent: 50
      })
    })
    expect(progress?.getAttribute('aria-valuenow')).toBe('50')
    expect(container.textContent).toContain('50 B / 100 B · 50%')

    await act(async () => {
      prepared.resolve({
        release,
        package: { candidateToken: 'candidate', diagnostics: [], installable: true }
      })
      await prepared.promise
    })
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(window.api.specialist.installMarketplace).toHaveBeenCalledWith({
      candidateToken: 'candidate',
      skillConflictResolutions: []
    })
  })

  it('shows the specific package validation reason and blocks installation', async () => {
    window.api.specialist.getMarketplaceRelease = vi.fn().mockResolvedValue(release)
    window.api.specialist.prepareMarketplaceInstall = vi.fn().mockResolvedValue({
      release,
      package: {
        candidateToken: 'invalid-package-candidate',
        diagnostics: [
          {
            severity: 'error',
            code: 'specialist.description-invalid',
            message: 'Description must be 1000 characters or fewer.',
            path: 'specialist.json'
          }
        ],
        installable: false
      }
    })

    await act(async () => {
      root.render(
        <SpecialistMarketplace
          view={{
            kind: 'marketplace-release',
            sourceId: 'github-example',
            id: 'example-specialist',
            version: '2.0.0'
          }}
          onNavigate={vi.fn()}
        />
      )
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Install Specialist')
        )!
      )
    })

    expect(container.textContent).toContain('specialist.description-invalid')
    expect(container.textContent).toContain('Description must be 1000 characters or fewer.')
    expect(container.textContent).not.toContain('Package verified')
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Continue installation')
      )?.disabled
    ).toBe(true)
  })
})
