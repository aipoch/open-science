import { parseWebModeOptions } from './web-service/options'

// Decides what a forwarded second-instance launch means, given only its argv — kept as a pure,
// dependency-injected unit (no Electron imports) so the serve-vs-window branch is unit-testable.
export type SecondInstanceRouterDeps = {
  // Start (or reuse) the web service on THIS already-running instance. Always attached: this launch
  // owns the app, not the web service, so a later `stop` must tear down only the service, not the app.
  ensureWebService: (port: number, opts: { attached: boolean }) => Promise<unknown>
  // Surface the existing main window for a plain re-launch (e.g. a double-click).
  showMainWindow: () => void
  // Report a failed on-demand start; must never throw back into the OS 'second-instance' event.
  onError: (error: unknown) => void
}

// A CLI `open-science start` forwards --serve/--open-science-headless, so start the web service here
// rather than opening a window. A plain re-launch carries neither, so surface the window as before.
// Uses an empty env so the decision rests purely on the forwarded argv, never the primary's own env.
export const routeSecondInstance = (argv: string[], deps: SecondInstanceRouterDeps): void => {
  const requested = parseWebModeOptions(argv, {})
  if (requested.enabled) {
    void Promise.resolve(deps.ensureWebService(requested.port, { attached: true })).catch(
      deps.onError
    )
    return
  }
  deps.showMainWindow()
}
