// Maps an overlay WebContentsView's webContents to the (main window, close handle) pair that owns it.
//
// Electron's BrowserWindow.fromWebContents resolves a webContents to the BrowserWindow that owns it as
// the window's *main* webContents. A child WebContentsView's webContents is not that, so the lookup is
// unreliable for the overlay. Instead the overlay manager records the pairing when it creates the view:
// the find-IPC handler routes search requests to owner.mainWindow, and the close channel invokes
// owner.closeOverlay to hide the bar.
export type FindOverlayOwner = { mainWindow: unknown; closeOverlay: () => void }

const owners = new WeakMap<object, FindOverlayOwner>()

export const registerFindOverlayOwner = (overlay: object, owner: FindOverlayOwner): void => {
  owners.set(overlay, owner)
}

export const unregisterFindOverlayOwner = (overlay: object): void => {
  owners.delete(overlay)
}

export const resolveFindOverlayOwner = (
  overlay: object | null | undefined
): FindOverlayOwner | undefined => (overlay ? owners.get(overlay) : undefined)
