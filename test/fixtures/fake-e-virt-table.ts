type TestTableHarness = {
  instances: Array<{
    ctx: { body: { headIndex: number; tailIndex: number }; scrollY: number }
    emit: (event: string) => void
    getRows: () => Array<Record<string, unknown>>
  }>
}

const style = document.createElement('style')
style.textContent = [
  '.e-virt-table-container{}',
  '.e-virt-table-overlayer{}',
  '.e-virt-table-editor{}',
  '.e-virt-table-context-menu{}'
].join('')
document.head.appendChild(style)

class TestEVirtTable {
  ctx: {
    body: { headIndex: number; tailIndex: number }
    scrollY: number
    containerElement: HTMLElement
    isTarget: (event: Event) => boolean
  }
  private readonly handlers = new Map<string, () => void>()
  private rows: Array<Record<string, unknown>> = []

  constructor(target: HTMLElement) {
    this.ctx = {
      body: { headIndex: 0, tailIndex: 20 },
      scrollY: 0,
      containerElement: target,
      isTarget: (event) => event.target instanceof Node && target.contains(event.target)
    }
    const harness = (
      globalThis as typeof globalThis & {
        __openScienceTestTableHarness?: TestTableHarness
      }
    ).__openScienceTestTableHarness
    harness?.instances.push({
      ctx: this.ctx,
      emit: (event) => this.handlers.get(event)?.(),
      getRows: () => this.rows
    })
  }

  on(event: string, handler: () => void): void {
    this.handlers.set(event, handler)
  }

  loadConfig(): void {
    // Layout behavior is outside the cache-policy fixture.
  }
  loadColumns(): void {
    // Column rendering is outside the cache-policy fixture.
  }
  loadData(rows: Array<Record<string, unknown>>): void {
    this.rows = rows
  }
  draw(): void {
    // Canvas painting is outside the cache-policy fixture.
  }
  doLayout(): void {
    // Layout behavior is outside the cache-policy fixture.
  }
  scrollTo(): void {
    // Scrolling is driven through the exposed test context.
  }
  destroy(): void {
    // The fixture owns no native resources.
  }
  setCustomHeader(): void {
    // Header resizing is outside the cache-policy fixture.
  }
}

export default TestEVirtTable
