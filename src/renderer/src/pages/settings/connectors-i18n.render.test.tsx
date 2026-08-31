// @vitest-environment jsdom
// Covers what a plain string swap gets wrong in this form: the command dropdown labels are catalog
// keys resolved at render (a stale `.label` would silently ship English), the headers hint runs
// through <Trans> with a `code` placeholder that must render a real element rather than literal
// markup, the credential hints are composed from independently-translated sentences whose order the
// catalog must not assume, and Cancel comes from the shared `common` namespace.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CustomServerView } from '../../../../shared/settings'
import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { ConnectorAddForm } from './ConnectorAddForm'

let container: HTMLDivElement
let root: Root
let renderKey = 0

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const setup = (): void => {
  useSettingsStore.setState({
    addCustomServer: vi.fn().mockResolvedValue(undefined),
    updateCustomServer: vi.fn().mockResolvedValue(undefined)
  } as never)
}

const render = (props: Partial<Parameters<typeof ConnectorAddForm>[0]> = {}): void => {
  act(() => {
    root.render(
      <ConnectorAddForm key={renderKey++} onDone={vi.fn()} onCancel={vi.fn()} {...props} />
    )
  })
}

const openAdvancedSettings = (): void => {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.includes('Advanced settings')
  )
  act(() => trigger?.click())
}

const editServer: CustomServerView = {
  id: 'srv-1',
  name: 'memory-server',
  displayName: 'Memory server',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory']
}

const envEditServer: CustomServerView = {
  ...editServer,
  hasEnv: true,
  environmentNames: ['API_TOKEN']
}

const remoteEditServer: CustomServerView = {
  id: 'srv-2',
  name: 'remote-server',
  displayName: 'Remote server',
  transport: 'streamable_http',
  enabled: true,
  url: 'https://example.com/mcp'
}

// hasHeaders is what puts the form into the Static-headers auth mode, which is the only state that
// renders the headers field the <Trans> hint below belongs to.
const headersEditServer: CustomServerView = {
  ...remoteEditServer,
  id: 'srv-3',
  name: 'headers-server',
  hasHeaders: true
}

beforeEach(() => {
  setup()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('ConnectorAddForm copy', () => {
  it('translates the mode switch and the trust confirmation', () => {
    render()
    expect(container.textContent).toContain('Local command')
    expect(container.textContent).toContain('Remote server')
    expect(container.textContent).toContain(
      'I trust this connector. Only add connectors from developers you trust.'
    )

    switchTo('zh-Hans')
    expect(container.textContent).toContain('本地命令')
    expect(container.textContent).toContain('远程服务器')
    expect(container.textContent).toContain('我信任这个连接器。只添加来自你信任的开发者的连接器。')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('本機指令')
    expect(container.textContent).toContain('遠端伺服器')
    expect(container.textContent).toContain('我信任這個連接器。只加入來自你信任的開發者的連接器。')
  })

  it('resolves the selected command label from the catalog, keeping the runtime name verbatim', () => {
    render()
    const trigger = container.querySelector('[aria-label="Command"]') as HTMLElement
    expect(trigger.textContent).toBe('npx — Node package')

    switchTo('zh-Hans')
    expect((container.querySelector('[aria-label="命令"]') as HTMLElement).textContent).toBe(
      'npx — Node 包'
    )

    switchTo('zh-Hant')
    expect((container.querySelector('[aria-label="指令"]') as HTMLElement).textContent).toBe(
      'npx — Node 套件'
    )
  })

  it('takes Cancel from the shared common namespace', () => {
    render()
    expect(container.textContent).toContain('Cancel')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('取消')
  })

  it('labels the submit button for add versus edit', () => {
    render()
    expect(container.textContent).toContain('Add connector')
    expect(container.textContent).not.toContain('Save changes')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('添加连接器')

    render({ editServer })
    expect(container.textContent).toContain('保存更改')
    expect(container.textContent).not.toContain('添加连接器')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('儲存變更')
  })

  // Add mode accepts values immediately. Edit mode defaults to the explicit keep action and exposes
  // saved names without rendering their values, so translations must cover both public states.
  it('translates the environment add hint and explicit edit action', () => {
    render()
    openAdvancedSettings()
    expect(container.textContent).toContain('One KEY=VALUE per line.')
    expect(container.textContent).not.toContain('Keep saved variables')

    render({ editServer: envEditServer })
    expect(container.textContent).toContain('Keep saved variables')
    expect(container.textContent).toContain('Saved names: API_TOKEN.')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('每行一条 KEY=VALUE。')
    expect(container.textContent).toContain('保留已保存的变量')
    expect(container.textContent).toContain('已保存的名称：API_TOKEN。')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('每行一條 KEY=VALUE。')
    expect(container.textContent).toContain('保留已儲存的變數')
    expect(container.textContent).toContain('已儲存的名稱：API_TOKEN。')
  })

  // The field is behind the Static-headers auth mode, which initializes from hasHeaders — hence the
  // edit fixture rather than initialTransport alone.
  it('renders the headers hint <code> placeholder as an element, not literal markup', () => {
    render({ editServer: headersEditServer })
    const hint = container.querySelector('#connector-headers')?.parentElement as HTMLElement
    const code = hint.querySelector('span.font-mono') as HTMLElement
    expect(code.textContent).toBe('Name: Value')
    expect(hint.textContent).toContain('One Name: Value per line (not JSON).')
    expect(hint.textContent).not.toContain('<code>')

    switchTo('zh-Hant')
    const zhHint = container.querySelector('#connector-headers')?.parentElement as HTMLElement
    expect((zhHint.querySelector('span.font-mono') as HTMLElement).textContent).toBe('Name: Value')
    expect(zhHint.textContent).toContain('每行一條 Name: Value（不是 JSON）。')
    expect(zhHint.textContent).not.toContain('<code>')
  })

  // The invocation name is immutable after creation, so editing disables the field. The hint explaining
  // what the name is used for is catalog copy, while `host.mcp(…)` is API surface and stays verbatim.
  it('translates the connector-ID hint and keeps the host.mcp call untranslated', () => {
    render({ editServer })
    const idField = container.querySelector('#connector-name-id') as HTMLInputElement
    expect(idField.disabled).toBe(true)
    expect(idField.value).toBe('memory-server')
    expect(container.textContent).toContain(
      'Used by host.mcp("memory-server", …), Specialists, and the generated MCP skill.'
    )

    switchTo('zh-Hans')
    expect(container.textContent).toContain(
      '供 host.mcp("memory-server", …)、专家和生成的 MCP 技能使用。'
    )

    switchTo('zh-Hant')
    expect(container.textContent).toContain(
      '供 host.mcp("memory-server", …)、專家和產生的 MCP 技能使用。'
    )
  })

  it('keeps protocol values untranslated in the remote fields', () => {
    render({ editServer: remoteEditServer })
    openAdvancedSettings()
    const transport = container.querySelector('[aria-label="Transport"]') as HTMLElement
    expect(transport.textContent).toBe('Streamable HTTP')
    expect((container.querySelector('#connector-url') as HTMLInputElement).value).toBe(
      'https://example.com/mcp'
    )

    switchTo('zh-Hans')
    expect((container.querySelector('[aria-label="传输方式"]') as HTMLElement).textContent).toBe(
      'Streamable HTTP'
    )
  })
})
