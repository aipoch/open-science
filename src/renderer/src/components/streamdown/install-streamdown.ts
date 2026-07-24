import type { SaveBlobFileRequest, SaveBlobFileResult } from '../../../../shared/file-save'
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV
} from 'streamdown'

const saveBlobFile = (request: SaveBlobFileRequest): Promise<SaveBlobFileResult> =>
  window.api.saveBlobFile(request)

const AGENT_MARKDOWN_ROOT_SELECTOR = '.agent-markdown-root'
const TABLE_FULLSCREEN_SELECTOR = '[data-streamdown="table-fullscreen"]'
const MERMAID_FULLSCREEN_SELECTOR =
  'body > div.fixed.inset-0.z-50.flex.items-center.justify-center[role="button"]:not([data-streamdown])'
const FULLSCREEN_SELECTOR = `${MERMAID_FULLSCREEN_SELECTOR}, ${TABLE_FULLSCREEN_SELECTOR}`
const FULLSCREEN_EXIT_MS = 150
const FULLSCREEN_FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/* --- Menu positioning (fullscreen + mermaid dropdowns) --- */

const MENU_SELECTOR = ':scope > div.absolute'

const usesFixedMenuPosition = (relative: HTMLElement): boolean =>
  Boolean(
    relative.closest('[data-streamdown="table-fullscreen"]') ||
    relative.closest('.agent-markdown-root [data-streamdown="mermaid-block-actions"]')
  )

const positionControlMenu = (relative: HTMLElement): void => {
  if (!usesFixedMenuPosition(relative)) return
  const button = relative.querySelector(':scope > button')
  if (!(button instanceof HTMLElement)) return

  const menu = relative.querySelector(MENU_SELECTOR)
  if (!(menu instanceof HTMLElement)) return

  const rect = button.getBoundingClientRect()
  const menuWidth = Math.max(menu.offsetWidth, 128)
  const rightAligned = Math.round(window.innerWidth - rect.right)
  const leftAligned = Math.round(window.innerWidth - rect.left - menuWidth)
  const useRight =
    rightAligned >= 8 && rightAligned + menuWidth <= window.innerWidth - 8
      ? Math.max(8, rightAligned)
      : Math.max(8, leftAligned)
  const top = Math.round(rect.bottom + 4)

  menu.style.setProperty('position', 'fixed', 'important')
  menu.style.setProperty('top', `${top}px`, 'important')
  menu.style.setProperty('right', `${useRight}px`, 'important')
  menu.style.setProperty('left', 'auto', 'important')
  menu.style.setProperty('bottom', 'auto', 'important')
  menu.style.setProperty('margin', '0', 'important')
}

const positionOpenMenus = (): void => {
  for (const relative of document.querySelectorAll<HTMLElement>(
    `${AGENT_MARKDOWN_ROOT_SELECTOR} .relative, ${TABLE_FULLSCREEN_SELECTOR} .relative`
  )) {
    if (relative.querySelector(MENU_SELECTOR) && usesFixedMenuPosition(relative)) {
      positionControlMenu(relative)
    }
  }
}

const scheduleMenuReposition = (relative: HTMLElement): void => {
  positionControlMenu(relative)
  requestAnimationFrame(() => {
    positionControlMenu(relative)
  })
}

const maybeRepositionMenu = (event: Event): void => {
  const target = event.target
  if (!(target instanceof Element)) return

  const button = target.closest('button')
  if (!(button instanceof HTMLButtonElement)) return
  if (button.closest(MENU_SELECTOR)) return

  const relative = button.parentElement
  if (!(relative instanceof HTMLElement) || !relative.classList.contains('relative')) return
  if (!usesFixedMenuPosition(relative)) return

  scheduleMenuReposition(relative)
}

const installMenuPositioning = (): (() => void) => {
  document.addEventListener('click', maybeRepositionMenu, true)
  window.addEventListener('resize', positionOpenMenus)
  document.addEventListener('scroll', positionOpenMenus, true)

  return () => {
    document.removeEventListener('click', maybeRepositionMenu, true)
    window.removeEventListener('resize', positionOpenMenus)
    document.removeEventListener('scroll', positionOpenMenus, true)
  }
}

/* --- Blob download patch (Electron sandbox) --- */

const originalCreateObjectURL = URL.createObjectURL.bind(URL)
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)
const blobByUrl = new Map<string, Blob>()
let streamdownDownloadGestureActive = false
let pendingImageDownloadUntil = 0

const markStreamdownDownloadGesture = (event: Event): void => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('button')) return
  if (
    !target.closest(
      `${AGENT_MARKDOWN_ROOT_SELECTOR}, ${TABLE_FULLSCREEN_SELECTOR}, ${MERMAID_FULLSCREEN_SELECTOR}`
    )
  ) {
    return
  }

  streamdownDownloadGestureActive = true
  queueMicrotask(() => {
    streamdownDownloadGestureActive = false
  })

  if (target.closest('[data-streamdown="image-wrapper"]')) {
    pendingImageDownloadUntil = performance.now() + 30_000
  }
}

const saveTrackedBlob = async (blob: Blob, filename: string): Promise<void> => {
  try {
    await saveBlobFile({
      suggestedName: filename,
      mimeType: blob.type || 'application/octet-stream',
      data: await blob.arrayBuffer()
    })
  } catch (error) {
    console.error('[streamdown-download] save failed:', error)
  }
}

const trySaveDownloadAnchor = (anchor: HTMLAnchorElement): boolean => {
  if (!anchor.download || !anchor.href.startsWith('blob:')) return false

  const blob = blobByUrl.get(anchor.href)
  if (!blob) return false

  void saveTrackedBlob(blob, anchor.download)
  blobByUrl.delete(anchor.href)
  return true
}

const installDownloads = (): (() => void) => {
  URL.createObjectURL = (blob: Blob): string => {
    const url = originalCreateObjectURL(blob)
    const claimsPendingImage =
      performance.now() <= pendingImageDownloadUntil && blob.type.startsWith('image/')
    if (streamdownDownloadGestureActive || claimsPendingImage) {
      blobByUrl.set(url, blob)
      if (claimsPendingImage) pendingImageDownloadUntil = 0
    }
    return url
  }

  URL.revokeObjectURL = (url: string): void => {
    blobByUrl.delete(url)
    originalRevokeObjectURL(url)
  }

  const onDownloadAnchor = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLAnchorElement)) return
    if (!trySaveDownloadAnchor(target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  document.addEventListener('click', markStreamdownDownloadGesture, true)
  document.addEventListener('click', onDownloadAnchor, true)

  return () => {
    document.removeEventListener('click', markStreamdownDownloadGesture, true)
    document.removeEventListener('click', onDownloadAnchor, true)
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    blobByUrl.clear()
    streamdownDownloadGestureActive = false
    pendingImageDownloadUntil = 0
  }
}

/* --- Mermaid SVG download --- */

const MERMAID_DOWNLOAD_BUTTON = '[data-streamdown="mermaid-block-actions"] .relative > button'

const serializeSvg = (svg: SVGSVGElement): string => {
  const clone = svg.cloneNode(true) as SVGSVGElement
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }
  return new XMLSerializer().serializeToString(clone)
}

const findMermaidSvg = (block: Element): SVGSVGElement | null => {
  const svg = block.querySelector('[data-streamdown="mermaid"] svg')
  return svg instanceof SVGSVGElement ? svg : null
}

const waitForMermaidSvg = (block: Element, timeoutMs = 4000): Promise<SVGSVGElement | null> =>
  new Promise((resolve) => {
    const existing = findMermaidSvg(block)
    if (existing) {
      resolve(existing)
      return
    }

    const deadline = Date.now() + timeoutMs
    const observer = new MutationObserver(() => {
      const svg = findMermaidSvg(block)
      if (svg) {
        observer.disconnect()
        resolve(svg)
      } else if (Date.now() >= deadline) {
        observer.disconnect()
        resolve(null)
      }
    })

    observer.observe(block, { childList: true, subtree: true })
    window.setTimeout(() => {
      observer.disconnect()
      resolve(findMermaidSvg(block))
    }, timeoutMs)
  })

const saveMermaidSvg = async (block: Element): Promise<void> => {
  const svg = (await waitForMermaidSvg(block)) ?? findMermaidSvg(block)
  if (!svg) {
    console.warn('[streamdown-download] mermaid svg not ready')
    return
  }

  const markup = serializeSvg(svg)
  await saveBlobFile({
    suggestedName: 'diagram.svg',
    mimeType: 'image/svg+xml',
    data: new TextEncoder().encode(markup).buffer
  })
}

const installMermaidDownload = (): (() => void) => {
  const onDownloadClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-streamdown="mermaid-block-actions"] .relative > .absolute')) return

    const button = target.closest(MERMAID_DOWNLOAD_BUTTON)
    if (!(button instanceof HTMLButtonElement)) return

    const block = button.closest('[data-streamdown="mermaid-block"]')
    if (!block) return

    event.preventDefault()
    event.stopImmediatePropagation()

    void saveMermaidSvg(block)
  }

  document.addEventListener('click', onDownloadClick, true)

  return () => {
    document.removeEventListener('click', onDownloadClick, true)
  }
}

/* --- Table copy / download --- */

const TABLE_MENU =
  '[data-streamdown="table-wrapper"] .relative > .absolute, [data-streamdown="table-fullscreen"] .relative > .absolute'

const INLINE_TOOLBAR_BUTTON =
  '.agent-markdown-root [data-streamdown="table-wrapper"] > div:first-child .relative > button'

type TableFormat = 'csv' | 'md' | 'tsv'
type TableAction = 'copy' | 'download'

const FORMAT_OPTIONS: Record<TableAction, Array<{ id: TableFormat; label: string }>> = {
  copy: [
    { id: 'md', label: 'Markdown' },
    { id: 'csv', label: 'CSV' },
    { id: 'tsv', label: 'TSV' }
  ],
  download: [
    { id: 'csv', label: 'CSV' },
    { id: 'md', label: 'Markdown' }
  ]
}

let activeTableMenu: HTMLElement | null = null

const findTableSurface = (from: Element): HTMLTableElement | null => {
  const wrapper = from.closest('[data-streamdown="table-wrapper"]')
  if (wrapper) {
    const table = wrapper.querySelector('table')
    return table instanceof HTMLTableElement ? table : null
  }

  const fullscreen = from.closest('[data-streamdown="table-fullscreen"]')
  if (fullscreen) {
    const table = fullscreen.querySelector('[data-streamdown="table"], table')
    return table instanceof HTMLTableElement ? table : null
  }

  return null
}

const getToolbarAction = (relative: HTMLElement): TableAction | null => {
  const toolbar =
    relative.closest('[data-streamdown="table-wrapper"] > div:first-child') ??
    relative.closest('[data-streamdown="table-fullscreen"] [role="presentation"] > div:first-child')

  if (!toolbar) return null

  const relatives = [...toolbar.querySelectorAll<HTMLElement>(':scope > .relative')]
  if (relatives[0] === relative) return 'copy'
  if (relatives[1] === relative) return 'download'
  return null
}

const copyTable = async (table: HTMLTableElement, format: TableFormat): Promise<void> => {
  const data = extractTableDataFromElement(table)
  const text =
    format === 'csv'
      ? tableDataToCSV(data)
      : format === 'tsv'
        ? tableDataToTSV(data)
        : tableDataToMarkdown(data)

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API not available')
  }

  await navigator.clipboard.writeText(format === 'csv' ? `\uFEFF${text}` : text)
}

const downloadTable = async (table: HTMLTableElement, format: 'csv' | 'md'): Promise<void> => {
  const data = extractTableDataFromElement(table)
  const isCsv = format === 'csv'
  const text = isCsv ? tableDataToCSV(data) : tableDataToMarkdown(data)

  await saveBlobFile({
    suggestedName: `table.${isCsv ? 'csv' : 'md'}`,
    mimeType: isCsv ? 'text/csv' : 'text/markdown',
    data: new TextEncoder().encode(isCsv ? `\uFEFF${text}` : text).buffer
  })
}

const runTableAction = async (
  table: HTMLTableElement,
  action: TableAction,
  format: TableFormat
): Promise<void> => {
  if (action === 'download' && format === 'tsv') return

  if (action === 'copy') {
    await copyTable(table, format)
  } else {
    await downloadTable(table, format === 'md' ? 'md' : 'csv')
  }
}

const closeActiveTableMenu = (): void => {
  activeTableMenu?.remove()
  activeTableMenu = null
}

const showInlineFormatMenu = (
  anchor: HTMLButtonElement,
  action: TableAction,
  table: HTMLTableElement
): void => {
  closeActiveTableMenu()

  const rect = anchor.getBoundingClientRect()
  const menu = document.createElement('div')
  menu.setAttribute('data-sd-table-format-menu', 'true')
  menu.className = 'sd-table-format-menu'

  for (const option of FORMAT_OPTIONS[action]) {
    const item = document.createElement('button')
    item.type = 'button'
    item.textContent = option.label
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeActiveTableMenu()
      void runTableAction(table, action, option.id).catch((error) => {
        console.error('[streamdown-table] action failed:', error)
      })
    })
    menu.appendChild(item)
  }

  document.body.appendChild(menu)

  const menuRect = menu.getBoundingClientRect()
  const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8)
  const left = Math.max(
    8,
    Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)
  )

  menu.style.top = `${Math.round(top)}px`
  menu.style.left = `${Math.round(left)}px`

  activeTableMenu = menu
}

const onFullscreenMenuPointer = (event: Event): void => {
  if (!(event instanceof MouseEvent) || event.button !== 0) return
  if (event.target instanceof Element && event.target.closest(INLINE_TOOLBAR_BUTTON)) return

  const target = event.target
  if (!(target instanceof Element)) return

  const menuButton = target.closest(`${TABLE_MENU} button`)
  if (!(menuButton instanceof HTMLButtonElement)) return
  if (!menuButton.closest('[data-streamdown="table-fullscreen"]')) return

  const relative = menuButton.closest('.relative')
  if (!(relative instanceof HTMLElement)) return

  const action = getToolbarAction(relative)
  if (!action) return

  const label = (menuButton.textContent ?? '').trim().toLowerCase()
  const format: TableFormat | null = label.includes('csv')
    ? 'csv'
    : label.includes('tsv')
      ? 'tsv'
      : label.includes('markdown') || label === 'md'
        ? 'md'
        : null
  if (!format) return
  if (action === 'download' && format === 'tsv') return

  const table = findTableSurface(relative)
  if (!table) return

  event.preventDefault()
  event.stopImmediatePropagation()

  void runTableAction(table, action, format).catch((error) => {
    console.error('[streamdown-table] action failed:', error)
  })
}

const onInlineToolbarPointer = (event: Event): void => {
  if (!(event instanceof MouseEvent) || event.button !== 0) return

  const target = event.target
  if (!(target instanceof Element)) return

  const button = target.closest(INLINE_TOOLBAR_BUTTON)
  if (!(button instanceof HTMLButtonElement)) return
  if (button.closest('[data-sd-table-format-menu]')) return

  const relative = button.parentElement
  if (!(relative instanceof HTMLElement)) return

  const action = getToolbarAction(relative)
  if (!action) return

  const table = findTableSurface(relative)
  if (!table) return

  event.preventDefault()
  event.stopImmediatePropagation()

  showInlineFormatMenu(button, action, table)
}

const onDismissTableMenu = (event: Event): void => {
  if (!activeTableMenu) return

  const target = event.target
  if (
    target instanceof Element &&
    target.closest('[data-sd-table-format-menu], ' + INLINE_TOOLBAR_BUTTON)
  ) {
    return
  }

  closeActiveTableMenu()
}

const onTableMenuEscape = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    closeActiveTableMenu()
  }
}

const installTableActions = (): (() => void) => {
  document.addEventListener('mousedown', onFullscreenMenuPointer, true)
  document.addEventListener('mousedown', onInlineToolbarPointer, true)
  document.addEventListener('mousedown', onDismissTableMenu, true)
  document.addEventListener('keydown', onTableMenuEscape)

  return () => {
    document.removeEventListener('mousedown', onFullscreenMenuPointer, true)
    document.removeEventListener('mousedown', onInlineToolbarPointer, true)
    document.removeEventListener('mousedown', onDismissTableMenu, true)
    document.removeEventListener('keydown', onTableMenuEscape)
    closeActiveTableMenu()
  }
}

/* --- Fullscreen dialog adapter --- */

let lastTableWrapper: HTMLElement | null = null

const syncFullscreenTable = (overlay: HTMLElement): void => {
  const fullscreenTable = overlay.querySelector<HTMLTableElement>('[data-streamdown="table"]')
  if (!fullscreenTable) return

  const sourceTable =
    (lastTableWrapper?.querySelector<HTMLTableElement>('[data-streamdown="table"]') ??
      [...document.querySelectorAll<HTMLElement>('[data-streamdown="table-wrapper"]')]
        .filter((wrapper) => !overlay.contains(wrapper))
        .map((wrapper) => wrapper.querySelector<HTMLTableElement>('[data-streamdown="table"]'))
        .find((table) => table && table.rows.length > 0)) ||
    null

  if (!sourceTable || sourceTable.rows.length === 0) return
  if (fullscreenTable.innerHTML === sourceTable.innerHTML) return

  fullscreenTable.innerHTML = sourceTable.innerHTML
}

const installTableFullscreenFix = (): (() => void) => {
  const onToolbarClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const wrapper = target.closest<HTMLElement>('[data-streamdown="table-wrapper"]')
    if (!wrapper) return

    const toolbar = wrapper.querySelector(':scope > div:first-child')
    const button = target.closest('button')
    if (!toolbar || !button || !toolbar.contains(button)) return
    if (button.closest('.relative')) return

    const topLevelButtons = [...toolbar.querySelectorAll(':scope > button')]
    if (topLevelButtons.at(-1) !== button) return

    lastTableWrapper = wrapper
  }

  const onOverlayAdded = (node: Node): void => {
    if (!(node instanceof HTMLElement)) return

    const overlay = node.matches('[data-streamdown="table-fullscreen"]')
      ? node
      : node.querySelector<HTMLElement>('[data-streamdown="table-fullscreen"]')

    if (!overlay) return

    syncFullscreenTable(overlay)
    requestAnimationFrame(() => {
      syncFullscreenTable(overlay)
    })
  }

  document.addEventListener('click', onToolbarClick, true)

  const overlayObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(onOverlayAdded)
    }
  })

  overlayObserver.observe(document.body, { childList: true })

  return () => {
    overlayObserver.disconnect()
    document.removeEventListener('click', onToolbarClick, true)
    lastTableWrapper = null
  }
}

const installFullscreenDialogAdapter = (): (() => void) => {
  const replayedCloseButtons = new WeakSet<HTMLButtonElement>()
  const closeTimers = new Map<HTMLElement, number>()
  const previousFocus = new WeakMap<HTMLElement, HTMLElement>()

  const findFullscreenCloseButton = (overlay: HTMLElement): HTMLButtonElement | null =>
    overlay.matches(TABLE_FULLSCREEN_SELECTOR)
      ? overlay.querySelector<HTMLButtonElement>(
          ':scope > div[role="presentation"] > div:first-child > button:last-of-type'
        )
      : overlay.querySelector<HTMLButtonElement>(':scope > button')

  const findFullscreenLayers = (node: Node): HTMLElement[] => {
    if (!(node instanceof HTMLElement)) return []

    const layers = [...node.querySelectorAll<HTMLElement>(FULLSCREEN_SELECTOR)]
    if (node.matches(FULLSCREEN_SELECTOR)) layers.unshift(node)
    return layers
  }

  const closeAfterAnimation = (overlay: HTMLElement): boolean => {
    const closeButton = findFullscreenCloseButton(overlay)
    if (!closeButton) return false

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    if (overlay.dataset.fullscreenState === 'closing') return true

    overlay.dataset.fullscreenState = 'closing'
    const timer = window.setTimeout(() => {
      closeTimers.delete(overlay)
      replayedCloseButtons.add(closeButton)
      closeButton.click()
    }, FULLSCREEN_EXIT_MS)
    closeTimers.set(overlay, timer)
    return true
  }

  const trapFullscreenFocus = (event: KeyboardEvent, overlay: HTMLElement): void => {
    const focusable = [
      ...overlay.querySelectorAll<HTMLElement>(FULLSCREEN_FOCUSABLE_SELECTOR)
    ].filter((element) => {
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (
          current.hidden ||
          current.inert ||
          current.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          return false
        }
        if (current === overlay) break
      }
      return true
    })
    if (focusable.length === 0) return

    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? activeIndex <= 0
        ? focusable.length - 1
        : activeIndex - 1
      : activeIndex < 0 || activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1

    event.preventDefault()
    event.stopImmediatePropagation()
    focusable[nextIndex]?.focus()
  }

  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const overlay = target.closest<HTMLElement>(FULLSCREEN_SELECTOR)
    if (!overlay) return

    const closeButton = findFullscreenCloseButton(overlay)
    if (!closeButton) return
    if (replayedCloseButtons.delete(closeButton)) return

    if (target === overlay) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!closeButton.contains(target) || !closeAfterAnimation(overlay)) return

    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // A portaled link confirmation is the active layer and owns Tab/Escape until it closes.
    if (document.querySelector('[data-streamdown="link-safety-panel"][data-state="open"]')) {
      return
    }

    const overlays = document.querySelectorAll<HTMLElement>(FULLSCREEN_SELECTOR)
    const overlay = overlays.item(overlays.length - 1)
    if (!overlay) return

    if (event.key === 'Tab') {
      trapFullscreenFocus(event, overlay)
      return
    }

    if (event.key !== 'Escape' || !closeAfterAnimation(overlay)) return

    event.preventDefault()
    event.stopImmediatePropagation()
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)

  const markAddedFullscreen = (node: Node): void => {
    for (const overlay of findFullscreenLayers(node)) {
      if (document.activeElement instanceof HTMLElement) {
        previousFocus.set(overlay, document.activeElement)
      }
      requestAnimationFrame(() => findFullscreenCloseButton(overlay)?.focus())
    }
  }

  const restoreRemovedFullscreenFocus = (node: Node): void => {
    for (const overlay of findFullscreenLayers(node)) {
      const target = previousFocus.get(overlay)
      if (target?.isConnected) requestAnimationFrame(() => target.focus())
      previousFocus.delete(overlay)
    }
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(markAddedFullscreen)
      mutation.removedNodes.forEach(restoreRemovedFullscreenFocus)
    }
  })
  observer.observe(document.body, { childList: true })

  return () => {
    observer.disconnect()
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    for (const timer of closeTimers.values()) window.clearTimeout(timer)
    closeTimers.clear()
  }
}

/* --- Public entry --- */

let installCount = 0
const uninstallers: Array<() => void> = []

const installStreamdown = (): (() => void) => {
  if (installCount === 0) {
    uninstallers.push(
      installMenuPositioning(),
      installDownloads(),
      installMermaidDownload(),
      installFullscreenDialogAdapter(),
      installTableActions(),
      installTableFullscreenFix()
    )
  }

  installCount += 1

  return () => {
    installCount = Math.max(0, installCount - 1)
    if (installCount === 0) {
      while (uninstallers.length > 0) {
        uninstallers.pop()?.()
      }
    }
  }
}

export { installStreamdown }
