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
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@example/research-mcp'],
  requiredSecrets: { environment: ['API_TOKEN'] }
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name
  )

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

    await act(async () => buttonNamed('Choose configuration')?.click())

    expect(document.body.textContent).toContain('example.json')
    expect(document.body.textContent).toContain('example-research')
    expect(document.body.textContent).toContain('Enter locally: API_TOKEN')
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

    await act(async () => buttonNamed('Choose configuration')?.click())

    expect(document.body.textContent).toContain('credential-like query parameter')
    expect(buttonNamed('Use configuration')?.disabled).toBe(true)
  })

  it('saves only with the digest returned by the export preview', async () => {
    const previewCustomServerTemplateExport = vi.fn().mockResolvedValue({
      connectorId: 'server-id',
      ready: true,
      diagnostics: [],
      definition,
      digest: 'preview-digest',
      suggestedFileName: 'open-science-connector-example-research.json'
    })
    const exportCustomServerTemplate = vi.fn().mockResolvedValue({ saved: true })
    window.api = {
      settings: { previewCustomServerTemplateExport, exportCustomServerTemplate }
    } as unknown as Window['api']
    act(() => {
      root.render(<ConnectorExportView id="server-id" onDone={vi.fn()} />)
    })
    await act(async () => undefined)

    expect(document.body.textContent).toContain('Names only: API_TOKEN')
    await act(async () => buttonNamed('Save configuration')?.click())

    expect(exportCustomServerTemplate).toHaveBeenCalledWith({
      id: 'server-id',
      expectedDigest: 'preview-digest'
    })
    expect(document.body.textContent).toContain('Configuration saved.')
  })
})
