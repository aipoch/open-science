export type WindowsBadgeLabel = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '9+'

export type DesktopBadgeWindow<Overlay = unknown> = {
  isDestroyed(): boolean
  setOverlayIcon(overlay: Overlay | null, description: string): void
}

type DesktopBadgeAdapterDeps<Overlay> = {
  platform: NodeJS.Platform
  setBadgeCount: (count: number) => boolean
  isUnityRunning: () => boolean
  getMainWindow: () => DesktopBadgeWindow<Overlay> | undefined
  createWindowsOverlay: (label: WindowsBadgeLabel) => Overlay
  onError?: (error: unknown) => void
}

export type DesktopBadgeAdapter = {
  setCount(count: number): void
}

// Windows overlay artwork stays legible by collapsing all double-digit counts to a fixed "9+".
const toWindowsBadgeLabel = (count: number): WindowsBadgeLabel =>
  count > 9 ? '9+' : (String(Math.max(1, count)) as WindowsBadgeLabel)

// Adapts one unread count to the native capability exposed by each desktop: Dock badges on macOS,
// launcher badges under Unity, and per-window taskbar overlay icons on Windows.
export const createDesktopBadgeAdapter = <Overlay>(
  deps: DesktopBadgeAdapterDeps<Overlay>
): DesktopBadgeAdapter => {
  const windowsOverlays = new Map<WindowsBadgeLabel, Overlay>()

  const setCount = (rawCount: number): void => {
    const count = Math.max(0, Math.floor(rawCount))

    try {
      if (deps.platform === 'darwin') {
        deps.setBadgeCount(count)
        return
      }

      // Electron only supports Linux badge counts on Unity; other desktops fail closed instead of
      // claiming support that the shell cannot render.
      if (deps.platform === 'linux') {
        if (deps.isUnityRunning()) deps.setBadgeCount(count)
        return
      }

      if (deps.platform !== 'win32') return

      const window = deps.getMainWindow()

      if (!window || window.isDestroyed()) return

      if (count === 0) {
        window.setOverlayIcon(null, '')
        return
      }

      const label = toWindowsBadgeLabel(count)
      let overlay = windowsOverlays.get(label)

      // NativeImage construction allocates a bitmap. Cache the ten possible labels and reuse them
      // when focus/window recreation causes the same count to be applied again.
      if (overlay === undefined) {
        overlay = deps.createWindowsOverlay(label)
        windowsOverlays.set(label, overlay)
      }

      window.setOverlayIcon(overlay, `${count} unread ${count === 1 ? 'message' : 'messages'}`)
    } catch (error) {
      deps.onError?.(error)
    }
  }

  return { setCount }
}

const DIGIT_GLYPHS: Record<Exclude<WindowsBadgeLabel, '9+'> | '+', readonly string[]> = {
  '1': ['010', '110', '010', '010', '111'],
  '2': ['110', '001', '010', '100', '111'],
  '3': ['110', '001', '010', '001', '110'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '110', '001', '110'],
  '6': ['011', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '110'],
  '+': ['000', '010', '111', '010', '000']
}

// Electron's Windows NativeImage bitmap is a 32-bit BGRA buffer. The glyphs are intentionally
// prebuilt and pixel-aligned at 16x16 so taskbar scaling does not blur small unread counts.
export const createWindowsBadgeBitmap = (label: WindowsBadgeLabel): Buffer => {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  const setPixel = (x: number, y: number, red: number, green: number, blue: number): void => {
    const offset = (y * size + x) * 4
    bitmap[offset] = blue
    bitmap[offset + 1] = green
    bitmap[offset + 2] = red
    bitmap[offset + 3] = 255
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 7.5
      const dy = y - 7.5
      if (dx * dx + dy * dy <= 56.25) setPixel(x, y, 217, 45, 32)
    }
  }

  const glyphs = label === '9+' ? [DIGIT_GLYPHS['9'], DIGIT_GLYPHS['+']] : [DIGIT_GLYPHS[label]]
  const scale = 2
  const logicalWidth = glyphs.length * 3 + (glyphs.length - 1)
  const startX = Math.floor((size - logicalWidth * scale) / 2)
  const startY = 3

  glyphs.forEach((glyph, glyphIndex) => {
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < row.length; column += 1) {
        if (row[column] !== '1') continue

        const pixelX = startX + (glyphIndex * 4 + column) * scale
        const pixelY = startY + rowIndex * scale

        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            setPixel(pixelX + x, pixelY + y, 255, 255, 255)
          }
        }
      }
    })
  })

  return bitmap
}
