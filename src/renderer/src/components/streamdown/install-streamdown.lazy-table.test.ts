// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  vi.doUnmock('./table-data-runtime')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const prepare = async (): Promise<{
  load: () => Promise<unknown>
  resolve: () => void
  reject: (error: Error) => void
  writeText: ReturnType<typeof vi.fn>
  saveBlobFile: ReturnType<typeof vi.fn>
  select: (action: 'copy' | 'download', format: string) => HTMLButtonElement
}> => {
  vi.resetModules()
  let resolve!: () => void
  let reject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const load = vi.fn(async () => {
    await ready
    return vi.importActual<typeof import('./table-data-runtime')>('./table-data-runtime')
  })
  vi.doMock('./table-data-runtime', load)
  const writeText = vi.fn().mockResolvedValue(undefined)
  const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  window.api = { saveBlobFile } as unknown as Window['api']
  const { installStreamdown } = await import('./install-streamdown')
  uninstall = installStreamdown()
  document.body.innerHTML = `
    <div class="agent-markdown-root">
      <div data-streamdown="table-wrapper">
        <div>
          <div class="relative"><button>Copy</button></div>
          <div class="relative"><button>Download</button></div>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Value</th></tr></thead>
          <tbody><tr><td>alpha</td><td>1</td></tr></tbody>
        </table>
      </div>
    </div>`
  const select = (action: 'copy' | 'download', format: string): HTMLButtonElement => {
    const trigger =
      document.querySelectorAll<HTMLButtonElement>('.relative > button')[action === 'copy' ? 0 : 1]
    trigger.click()
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent === format
    )!
    option.click()
    return trigger
  }
  return { load, resolve, reject, writeText, saveBlobFile, select }
}

describe('first table action while its runtime is loading', () => {
  it.each([
    ['copy', 'Markdown', '| Name | Value |\n| --- | --- |\n| alpha | 1 |'],
    ['copy', 'CSV', '\uFEFFName,Value\nalpha,1'],
    ['copy', 'TSV', 'Name\tValue\nalpha\t1'],
    ['download', 'Markdown', '| Name | Value |\n| --- | --- |\n| alpha | 1 |'],
    ['download', 'CSV', '\uFEFFName,Value\nalpha,1']
  ] as const)('performs %s %s exactly once after loading', async (action, format, expected) => {
    const fixture = await prepare()
    expect(fixture.load).not.toHaveBeenCalled()
    const trigger = fixture.select(action, format)
    await vi.waitFor(() => expect(fixture.load).toHaveBeenCalledOnce())
    expect(fixture.writeText).not.toHaveBeenCalled()
    expect(fixture.saveBlobFile).not.toHaveBeenCalled()
    expect(document.querySelector('[data-sd-table-format-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fixture.resolve()
    // Finish the real cold import before checking its effect or replacing browser globals.
    await vi.dynamicImportSettled()
    if (action === 'copy') {
      await vi.waitFor(() => expect(fixture.writeText).toHaveBeenCalledExactlyOnceWith(expected))
      expect(fixture.saveBlobFile).not.toHaveBeenCalled()
    } else {
      await vi.waitFor(() => expect(fixture.saveBlobFile).toHaveBeenCalledOnce())
      const request = fixture.saveBlobFile.mock.calls[0][0]
      expect(request.suggestedName).toBe(format === 'CSV' ? 'table.csv' : 'table.md')
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(request.data)).toBe(expected)
      expect(fixture.writeText).not.toHaveBeenCalled()
    }
  })

  it('contains a failed lazy import without writing or leaving a stuck menu', async () => {
    const error = new Error('Table runtime unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fixture = await prepare()
    const trigger = fixture.select('copy', 'Markdown')
    await vi.waitFor(() => expect(fixture.load).toHaveBeenCalledOnce())
    fixture.reject(error)
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[streamdown-table] action failed:',
        expect.objectContaining({ cause: error })
      )
    )
    expect(fixture.writeText).not.toHaveBeenCalled()
    expect(fixture.saveBlobFile).not.toHaveBeenCalled()
    expect(document.querySelector('[data-sd-table-format-menu]')).toBeNull()
    trigger.click()
    expect(document.querySelector('[data-sd-table-format-menu]')).not.toBeNull()
  })
})
