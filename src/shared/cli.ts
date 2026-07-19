// Status of the `open-science` command-line launcher that the app can install into the user's PATH.
// The launcher is a tiny shim that runs the bundled CLI via the app's own Electron in Node mode, so no
// separate Node install is needed. Shared between the main-process installer and the settings UI.
export type CliLauncherStatus = {
  // Whether the shim currently exists on disk at `target`.
  installed: boolean
  // Absolute path where the shim is (or would be) written.
  target: string
  // Whether `target`'s directory is on the user's PATH, i.e. `open-science` is callable by name.
  onPath: boolean
  // A one-line follow-up shown to the user when a manual step remains (PATH not yet active, or a new
  // terminal is required on Windows after editing the user PATH). Absent when nothing more is needed.
  pathHint?: string
}
