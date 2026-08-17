// @vitest-environment jsdom
// Proves the Agent panel's pieces read from the catalog rather than shipping literals, and that the
// install-source picker resolves the keys the shared module hands it. Catalog parity can't catch a
// component that never calls t(), nor a key that no longer exists on the shared descriptor.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { AgentInstallSourceMenu } from './AgentInstallSourceMenu'
import { describeInstallProgress } from './claude-install-progress'
import { getClaudeInstallSources, getOpencodeInstallSources } from '../../../../shared/settings'

let container: HTMLDivElement
let root: Root

const render = (element: React.JSX.Element): void => {
  act(() => {
    root.render(element)
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
})

const menuProps = {
  name: 'Claude Agent',
  sources: getClaudeInstallSources('darwin'),
  installing: false,
  disabled: false,
  npmAvailable: true,
  blockedInstallSources: {},
  onInstall: (): void => {}
}

describe('AgentInstallSourceMenu', () => {
  it('translates the trigger by intent, not by display text', () => {
    render(<AgentInstallSourceMenu {...menuProps} intent="install" />)
    expect(container.textContent).toContain('Install')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('安装')

    // The repair intent must pick its own label in the same locale — proving the icon/label choice
    // keys off `intent` and not off whatever the button happens to read.
    render(<AgentInstallSourceMenu {...menuProps} intent="repair" />)
    expect(container.textContent).toContain('修复')
    expect(container.textContent).not.toContain('安装')
  })
})

describe('install source descriptors', () => {
  it('resolves every shared labelKey and descriptionKey in both languages', () => {
    const sources = [
      ...getClaudeInstallSources('darwin'),
      ...getClaudeInstallSources('win32'),
      ...getOpencodeInstallSources('linux')
    ]

    // English is excluded on purpose: keys ARE the English text, so English resolves through the
    // missing-key fallback and echoing the key back is the correct result. Only a translated locale
    // can distinguish "translated" from "absent".
    for (const language of ['zh-Hans', 'zh-Hant']) {
      const t = i18next.getFixedT(language)
      for (const source of sources) {
        // An echo here means the key has no catalog entry. That would slip past catalog parity
        // because the key lives on the shared descriptor rather than in the catalog.
        expect(t(source.labelKey)).not.toBe(source.labelKey)
        if (source.descriptionKey) {
          expect(t(source.descriptionKey)).not.toBe(source.descriptionKey)
        }
      }
    }
  })

  it('picks the platform-specific official-script label', () => {
    const t = i18next.getFixedT('en')
    const win = getClaudeInstallSources('win32').find((s) => s.id === 'official-script')
    const mac = getClaudeInstallSources('darwin').find((s) => s.id === 'official-script')

    expect(t(win!.labelKey)).toContain('install.ps1')
    expect(t(mac!.labelKey)).toContain('install.sh')
  })
})

describe('describeInstallProgress', () => {
  it('localizes the phase label while interpolating byte counts', () => {
    const zh = i18next.getFixedT('zh-Hans')
    const tick = { kind: 'progress', installId: 'i1' } as const
    expect(describeInstallProgress({ ...tick, phase: 'extracting' }, zh).label).toBe('解压中…')

    const sized = describeInstallProgress(
      { ...tick, phase: 'downloading', receivedBytes: 1048576, totalBytes: 4194304 },
      zh
    )
    expect(sized.label).toBe('下载中 —— 1.0 / 4.0 MB')
    expect(sized.fraction).toBeCloseTo(0.25)
  })
})
