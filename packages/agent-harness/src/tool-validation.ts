/** Only deliberately public validation diagnostics may be returned to a model. */
export class ToolValidationError extends Error {
  constructor(issues: readonly { path: string; expected: string }[]) {
    super(
      'Invalid tool arguments: ' +
        issues
          .slice(0, 8)
          .map(({ path, expected }) => `${path.slice(0, 160)}: expected ${expected.slice(0, 160)}`)
          .join('; ')
    )
    this.name = 'ToolValidationError'
  }
}

const ARGUMENT_RECOVERY =
  'Correct only the reported arguments and call the same tool again. Do not switch to another tool or route because of this error.'

export function toolValidationMessage(error: unknown): string {
  const message = error instanceof ToolValidationError ? error.message : 'Invalid tool arguments'
  return `${message}\n${ARGUMENT_RECOVERY}`
}
