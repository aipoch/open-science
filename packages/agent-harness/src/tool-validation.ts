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

export function toolValidationMessage(error: unknown): string {
  return error instanceof ToolValidationError ? error.message : 'Invalid tool arguments'
}
