// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodexStatusCard } from './CodexStatusCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (
  props: Partial<React.ComponentProps<typeof CodexStatusCard>> = {}
): (() => void) => {
  const onInstall = props.onInstall ?? vi.fn()

  act(() => {
    root.render(
      <CodexStatusCard
        codex={{}}
        codexReady={false}
        isDetecting={false}
        onDetect={vi.fn()}
        isInstalling={false}
        installLogs={[]}
        installProgress={null}
        installError={undefined}
        npmAvailable
        onInstall={onInstall}
        {...props}
      />
    )
  })

  return onInstall as () => void
}

describe('CodexStatusCard', () => {
  it('shows adapter and native Codex details when the runtime is detected', () => {
    render({
      codex: {
        resolvedPath: '/data/codex-acp/bin/codex-acp',
        version: '1.1.4',
        nativeVersion: '0.106.0'
      },
      codexReady: true
    })

    expect(container.textContent).toContain('Codex is ready')
    expect(container.textContent).toContain('/data/codex-acp/bin/codex-acp')
    expect(container.textContent).toContain('1.1.4')
    expect(container.textContent).toContain('0.106.0')
    expect(container.querySelector('[aria-label="Install source"]')).toBeNull()
  })

  it('offers reinstall when a detected Codex pair fails readiness checks', () => {
    render({
      codex: {
        resolvedPath: '/data/codex-managed/adapter/dist/index.js',
        version: '1.1.4'
      },
      codexReady: false
    })

    expect(container.textContent).toContain('Codex installation needs repair')
    expect(container.textContent).toContain('paired native Codex runtime did not pass detection')
    expect(container.querySelector('[aria-label="Install source"]')).not.toBeNull()
  })

  it('offers app-managed installation by default when Codex is missing', () => {
    const onInstall = vi.fn()
    render({ codex: {}, onInstall })

    expect(container.textContent).toContain('Codex not detected')
    const trigger = container.querySelector('[aria-label="Install source"]')
    expect(trigger?.tagName).toBe('BUTTON')
    expect(trigger?.textContent).toContain('App-managed download (recommended)')
    expect(container.textContent).not.toContain('Official install')
    expect(container.textContent).not.toContain('ChatGPT')

    const install = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Install with one click')
    )
    act(() => install?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onInstall).toHaveBeenCalledWith('managed')
  })

  it('selects only a ready runtime and locks selection while another operation runs', () => {
    const installed = {
      resolvedPath: '/usr/local/bin/codex-acp',
      version: '1.1.4',
      nativeVersion: '0.106.0'
    }
    const onSelect = vi.fn()

    render({ codex: installed, codexReady: false, onSelect })
    expect(container.querySelector('[role="radio"]')).toBeNull()

    render({ codex: installed, codexReady: true, onSelect, selectDisabled: true })
    const lockedRadio = container.querySelector<HTMLButtonElement>('[role="radio"]')
    expect(lockedRadio?.disabled).toBe(true)
    act(() => lockedRadio?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).not.toHaveBeenCalled()

    render({ codex: installed, codexReady: true, onSelect, selectDisabled: false })
    const radio = container.querySelector<HTMLButtonElement>('[role="radio"]')
    expect(radio?.getAttribute('aria-label')).toBe('Use Codex')
    act(() => radio?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('allows only an inactive app-managed runtime to be uninstalled', () => {
    const installed = {
      resolvedPath: '/data/codex-acp/bin/codex-acp',
      version: '1.1.4',
      nativeVersion: '0.106.0'
    }
    const onUninstall = vi.fn()
    const findUninstall = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Uninstall')
      )

    render({ codex: installed, onUninstall })
    expect(findUninstall()).toBeUndefined()

    render({ codex: installed, managed: true, onUninstall })
    const inactiveButton = findUninstall()
    expect(inactiveButton?.disabled).toBe(false)
    act(() => inactiveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUninstall).toHaveBeenCalledTimes(1)

    render({ codex: installed, managed: true, active: true, onUninstall })
    expect(findUninstall()?.disabled).toBe(true)
    expect(findUninstall()?.title).toContain('Switch to the other framework')

    render({ codex: installed, managed: true, isUninstalling: true, onUninstall })
    expect(findUninstall()?.disabled).toBe(true)
  })

  it('re-detects Codex and exposes the detecting state', () => {
    const onDetect = vi.fn()
    render({ codex: {}, onDetect })

    const redetect = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Re-detect')
    )
    expect(redetect?.disabled).toBe(false)
    act(() => redetect?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDetect).toHaveBeenCalledTimes(1)

    render({ codex: {}, isDetecting: true, onDetect })
    const detecting = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Detecting')
    )
    expect(detecting?.disabled).toBe(true)
    expect(detecting?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
  })

  it('shows install progress, errors, and logs using the shared install presentation', () => {
    render({
      codex: {},
      isInstalling: true,
      installProgress: {
        kind: 'progress',
        installId: 'codex-install-1',
        phase: 'downloading',
        receivedBytes: 50,
        totalBytes: 100
      },
      installError: 'Download failed',
      installLogs: ['Fetching adapter\n', 'Network unavailable\n']
    })

    const install = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Installing')
    )
    expect(install?.disabled).toBe(true)

    const progress = container.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuenow')).toBe('50')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Download failed')
    expect(container.querySelector('[aria-label="Install log"]')?.textContent).toContain(
      'Network unavailable'
    )
  })
})
