// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistMarketplace } from './SpecialistMarketplace'
import type { MarketplaceSnapshot } from '../../../../shared/specialist-marketplace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const deferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  return {
    promise: new Promise<Value>((done) => {
      resolve = done
    }),
    resolve
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

    expect(container.textContent).toContain('Example Specialist')
    expect(container.textContent).toContain('User-added source')
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    const listing = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Example Specialist')
    )
    fireEvent.click(listing!)
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'marketplace-release',
      sourceId: 'github-example',
      id: 'example-specialist',
      version: '1.0.0'
    })
  })

  it('hides stale listings while returning from a release to the Marketplace', async () => {
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

    expect(container.textContent).toContain('Loading Marketplace…')
    expect(container.textContent).not.toContain('Example Specialist')

    await act(async () => {
      refresh.resolve(snapshot)
      await refresh.promise
    })
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
        (button) => button.textContent?.trim() === 'Open'
      )!
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'example-specialist' })
  })

  it('allows reviewing a Specialist with every optional Skill deselected', async () => {
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

    const review = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review installation')
    )
    expect(review?.disabled).toBe(false)
    fireEvent.click(review!)
    expect(container.textContent).toContain('Review installation')
    expect(container.textContent).toContain('Skills0')
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

  it('downloads an update for review before explicitly confirming overwrite', async () => {
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
            version: '2.0.0'
          }}
          onNavigate={onNavigate}
        />
      )
    })
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )

    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Download and review')
        )!
      )
    })
    expect(window.api.specialist.installMarketplace).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Package verified')
    expect(container.textContent).toContain(
      'The download, checksum, and package structure passed verification.'
    )
    expect(container.textContent).toContain('Update from v1.0.0 to v2.0.0')
    expect(container.textContent).toContain('Local changes')
    expect(container.textContent).not.toContain('Back to Marketplace')
    const verified = Array.from(container.querySelectorAll<HTMLElement>('[role="status"]')).find(
      (element) => element.textContent?.includes('Package verified')
    )
    expect(verified?.className).toContain('bg-status-success-surface')
    expect(verified?.className).not.toMatch(/(?:bg|border|text)-green-/)

    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Update Specialist')
        )!
      )
    })
    expect(window.api.specialist.installMarketplace).toHaveBeenCalledWith({
      candidateToken: 'update-candidate',
      confirmOverwrite: true,
      skillConflictResolutions: []
    })
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'example-specialist' })
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
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Download and review')
        )!
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
    expect(container.textContent).not.toContain('Download and review')
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
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )
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
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Download and review')
        )!
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
    expect(container.textContent).toContain('Download and review')
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
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Download and review')
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

    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Back'
      )!
    )
    expect(window.api.specialist.cancelMarketplaceCandidate).toHaveBeenCalledWith({
      candidateToken: 'candidate'
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
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Review installation')
      )!
    )
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('Download and review')
        )!
      )
    })

    expect(container.textContent).toContain('specialist.description-invalid')
    expect(container.textContent).toContain('Description must be 1000 characters or fewer.')
    expect(container.textContent).not.toContain('Package verified')
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Install Specialist')
      )?.disabled
    ).toBe(true)
  })
})
