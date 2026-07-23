// Standing reason (if any) a runtime's uninstall button is disabled, as English tooltip copy. Returns
// null when the button is actionable (a non-active app-managed runtime) or only transiently disabled by
// a busy state — those get no `?`. Kept separate from the component so the exact copy and branching are
// unit-tested directly, without depending on Radix tooltip open-state in jsdom.
export const uninstallDisabledHint = (
  label: string,
  uninstallCommand: string,
  {
    managed,
    active,
    promptInFlight
  }: { managed: boolean; active: boolean; promptInFlight?: boolean }
): string | null => {
  if (!managed) {
    return `${label} was found on your system but isn't managed by the app, so it can't be uninstalled from here. Remove it with the tool you used to install it — for example \`${uninstallCommand}\`, your package manager, or by deleting it from your PATH — then re-detect.`
  }

  if (active) {
    return `${label} is the active agent framework and can't be uninstalled. Switch to another framework first, then uninstall.`
  }

  if (promptInFlight) {
    return 'A task is running — wait for it to finish before uninstalling.'
  }

  return null
}
