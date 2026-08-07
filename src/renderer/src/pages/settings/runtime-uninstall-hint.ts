import type { TFunction } from 'i18next'

// Standing reason (if any) a runtime's uninstall button is disabled, as tooltip copy. Returns null when
// the button is actionable (a non-active app-managed runtime) or only transiently disabled by a busy
// state — those get no `?`. Takes `t` rather than reaching for the i18next singleton, so the branching
// stays a pure function of (state, locale) and is unit-tested directly, without depending on Radix
// tooltip open-state in jsdom.
export const uninstallDisabledHint = (
  label: string,
  uninstallCommand: string,
  {
    managed,
    active,
    promptInFlight
  }: { managed: boolean; active: boolean; promptInFlight?: boolean },
  t: TFunction
): string | null => {
  if (!managed) {
    // The framework name and the shell command are both caller-supplied data, so they interpolate
    // rather than being folded into the sentence.
    return t(
      "{{label}} was found on your system but isn't managed by the app, so it can't be uninstalled from here. Remove it with the tool you used to install it — for example `{{command}}`, your package manager, or by deleting it from your PATH — then re-detect.",
      { label, command: uninstallCommand }
    )
  }

  if (active) {
    return t(
      "{{label}} is the active agent framework and can't be uninstalled. Switch to another framework first, then uninstall.",
      { label }
    )
  }

  // Intentionally keyed on the runtime-wide promptInFlight, not on `active`: during a deferred
  // reconnect the framework serving the in-flight prompt is already non-active (the user switched
  // away, but its process keeps running until the turn settles). Gating this on `active` would let
  // that still-busy framework be uninstalled mid-task — exactly the hazard this guard exists to
  // prevent. The cost is a conservative over-block: an unrelated idle managed framework also can't be
  // uninstalled while a task runs elsewhere. That errs safe (blocks more, never less), so it stays.
  if (promptInFlight) {
    return t('A task is running — wait for it to finish before uninstalling.')
  }

  return null
}
