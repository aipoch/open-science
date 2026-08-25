// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorExportView } from './ConnectorExportView'
import { ConnectorImportView } from './ConnectorImportView'

let container: HTMLDivElement
let root: Root

const definition = {
  schemaVersion: 1 as const,
  kind: 'open-science.connector' as const,
  name: 'example-research',
  displayName: 'Example Research',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@example/research-mcp'],
  requiredSecrets: { environment: ['API_TOKEN'] }
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name
  )

const buttonContaining = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(name)
  )

const dropFile = async (file: File): Promise<void> => {
  const dropEvent = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(dropEvent, 'dataTransfer', {
    value: { types: ['Files'], files: [file], dropEffect: 'none' }
  })
  await act(async () => {
    buttonContaining('Drag and drop or click to choose')?.dispatchEvent(dropEvent)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('Connector configuration transfer views', () => {
  it('shows a validated import preview before handing it to the Add form', async () => {
    const contents = JSON.stringify(definition)
    const selectCustomServerTemplate = vi.fn().mockResolvedValue({
      cancelled: false,
      fileName: 'example.json',
      preview: { ready: true, diagnostics: [], definition }
    })
    window.api = {
      settings: { selectCustomServerTemplate }
    } as unknown as Window['api']
    const onUse = vi.fn()
    act(() => {
      root.render(<ConnectorImportView onUse={onUse} onCancel={vi.fn()} />)
    })
    const file = new File([contents], 'example.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(contents) })

    await dropFile(file)

    expect(selectCustomServerTemplate).toHaveBeenCalledWith({
      fileName: 'example.json',
      contents
    })
    expect(document.body.textContent).toContain('example.json')
    expect(document.body.textContent).toContain('example-research')
    expect(document.body.textContent).toContain('Enter locally: API_TOKEN')
    expect(container.firstElementChild?.firstElementChild?.className).toContain('w-full')
    act(() => buttonNamed('Use configuration')?.click())
    expect(onUse).toHaveBeenCalledWith(definition)
  })

  it('shows import diagnostics and keeps invalid configurations unusable', async () => {
    window.api = {
      settings: {
        selectCustomServerTemplate: vi.fn().mockResolvedValue({
          cancelled: false,
          fileName: 'invalid.json',
          preview: {
            ready: false,
            diagnostics: [
              {
                severity: 'error',
                code: 'connector-template.url-secret',
                message: 'Server URL contains a credential-like query parameter.',
                path: 'url'
              }
            ]
          }
        })
      }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorImportView onUse={vi.fn()} onCancel={vi.fn()} />)
    })

    await act(async () => buttonContaining('Drag and drop or click to choose')?.click())

    expect(document.body.textContent).toContain('credential-like query parameter')
    expect(buttonNamed('Use configuration')?.disabled).toBe(true)
  })

  it('selects one server from a multi-server MCP client configuration', async () => {
    const remoteDefinition = {
      ...definition,
      name: 'remote-research',
      displayName: 'Remote Research',
      transport: 'streamable_http' as const,
      command: undefined,
      args: undefined,
      url: 'https://mcp.example.test/mcp'
    }
    window.api = {
      settings: {
        selectCustomServerTemplate: vi.fn().mockResolvedValue({
          cancelled: false,
          fileName: 'mcp.json',
          preview: {
            ready: true,
            sourceFormat: 'mcp-client',
            definition,
            definitions: [definition, remoteDefinition],
            diagnostics: []
          }
        })
      }
    } as unknown as Window['api']
    const onUse = vi.fn()
    act(() => root.render(<ConnectorImportView onUse={onUse} onCancel={vi.fn()} />))

    await act(async () => buttonContaining('Drag and drop or click to choose')?.click())
    const select = document.body.querySelector('select')!
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => buttonNamed('Use configuration')?.click())

    expect(document.body.textContent).toContain('Remote Research')
    expect(onUse).toHaveBeenCalledWith(remoteDefinition)
  })

  it('uses the Settings danger banner for import failures', async () => {
    window.api = {
      settings: {
        selectCustomServerTemplate: vi.fn().mockRejectedValue(new Error('Could not read file'))
      }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorImportView onUse={vi.fn()} onCancel={vi.fn()} />)
    })

    await act(async () => buttonContaining('Drag and drop or click to choose')?.click())

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Could not read file')
    expect(alert?.className).toContain('border-danger-000/30')
  })

  it('keeps a local-only path warning importable', async () => {
    const localDefinition = {
      ...definition,
      command: 'node',
      args: ['/Users/example/bin/server.mjs', '--stdio']
    }
    window.api = {
      settings: {
        selectCustomServerTemplate: vi.fn().mockResolvedValue({
          cancelled: false,
          fileName: 'local.json',
          preview: {
            ready: true,
            definition: localDefinition,
            diagnostics: [
              {
                severity: 'warning',
                code: 'connector-template.local-argument',
                message:
                  'args[0] uses a local path and may need to be changed on another computer.',
                path: 'args[0]'
              }
            ]
          }
        })
      }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorImportView onUse={vi.fn()} onCancel={vi.fn()} />)
    })

    await act(async () => buttonContaining('Drag and drop or click to choose')?.click())

    expect(document.body.textContent).toContain('may need to be changed on another computer')
    expect(buttonNamed('Use configuration')?.disabled).toBe(false)
  })

  it('saves only with the digest returned by the export preview', async () => {
    const previewCustomServerTemplateExport = vi.fn().mockResolvedValue({
      connectorId: 'server-id',
      ready: true,
      diagnostics: [],
      definition,
      digest: 'preview-digest',
      suggestedFileName: 'open-science-connector-example-research.json',
      mcpClientDigest: 'mcp-preview-digest',
      mcpClientSuggestedFileName: 'mcp-example-research.json'
    })
    const exportCustomServerTemplate = vi.fn().mockResolvedValue({ saved: true })
    window.api = {
      settings: { previewCustomServerTemplateExport, exportCustomServerTemplate }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorExportView id="server-id" onDone={vi.fn()} />)
    })
    await act(async () => undefined)

    expect(container.firstElementChild?.firstElementChild?.className).toContain('w-full')
    expect(document.body.textContent).toContain('Names only: API_TOKEN')
    await act(async () => buttonNamed('Save configuration')?.click())

    expect(exportCustomServerTemplate).toHaveBeenCalledWith({
      id: 'server-id',
      expectedDigest: 'preview-digest',
      format: 'open-science'
    })
    expect(document.body.textContent).toContain('Configuration saved.')
  })

  it('exports the MCP client configuration with its own preview digest', async () => {
    window.api = {
      settings: {
        previewCustomServerTemplateExport: vi.fn().mockResolvedValue({
          connectorId: 'server-id',
          ready: true,
          diagnostics: [],
          definition,
          digest: 'preview-digest',
          suggestedFileName: 'open-science-connector-example-research.json',
          mcpClientDigest: 'mcp-preview-digest',
          mcpClientSuggestedFileName: 'mcp-example-research.json'
        }),
        exportCustomServerTemplate: vi.fn().mockResolvedValue({ saved: true })
      }
    } as unknown as Window['api']
    act(() => root.render(<ConnectorExportView id="server-id" onDone={vi.fn()} />))
    await act(async () => undefined)

    act(() => buttonNamed('MCP client config')?.click())
    await act(async () => buttonNamed('Save configuration')?.click())

    expect(window.api.settings.exportCustomServerTemplate).toHaveBeenCalledWith({
      id: 'server-id',
      expectedDigest: 'mcp-preview-digest',
      format: 'mcp-client'
    })
  })

  it('re-enables Connector export after the user cancels Save As', async () => {
    const previewCustomServerTemplateExport = vi.fn().mockResolvedValue({
      connectorId: 'server-id',
      ready: true,
      diagnostics: [],
      definition,
      digest: 'preview-digest',
      suggestedFileName: 'open-science-connector-example-research.json'
    })
    const exportCustomServerTemplate = vi.fn().mockResolvedValue({ saved: false })
    window.api = {
      settings: { previewCustomServerTemplateExport, exportCustomServerTemplate }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorExportView id="server-id" onDone={vi.fn()} />)
    })
    await act(async () => undefined)

    await act(async () => buttonNamed('Save configuration')?.click())

    expect(buttonNamed('Save configuration')?.disabled).toBe(false)
    await act(async () => buttonNamed('Save configuration')?.click())
    expect(exportCustomServerTemplate).toHaveBeenCalledTimes(2)
  })

  it('uses the Settings danger banner for export failures', async () => {
    window.api = {
      settings: {
        previewCustomServerTemplateExport: vi
          .fn()
          .mockRejectedValue(new Error('Could not prepare export'))
      }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorExportView id="server-id" onDone={vi.fn()} />)
    })
    await act(async () => undefined)

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Could not prepare export')
    expect(alert?.className).toContain('border-danger-000/30')
  })
})
