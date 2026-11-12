import type { BaseWindow } from 'electron'
import type { WindowFindAppearance } from '../shared/window-controls'
import type { FileDialogAppearance } from '../shared/file-dialog-ui'

const appearances = new WeakMap<BaseWindow, FileDialogAppearance>()
let latest: FileDialogAppearance | undefined

// Reuse the validated app appearance projection; a disposable helper profile owns no preference.
export function rememberFileDialogAppearance(
  window: BaseWindow,
  appearance: WindowFindAppearance
): void {
  latest = {
    theme: appearance.theme,
    followsSystem: appearance.followsSystem,
    locale: appearance.localization?.lang
  }
  appearances.set(window, latest)
}

export function getFileDialogAppearance(parent?: BaseWindow): FileDialogAppearance | undefined {
  return (parent && appearances.get(parent)) || latest
}
