import { pythonRandomStateSchema } from '../../shared/notebook-execution-context'
import type { NotebookExecutionContext } from '../../shared/notebook-execution-context'

export const validatePythonRandomState = (
  value: unknown
):
  | Extract<NotebookExecutionContext['before']['pythonRandomState'], { state: 'available' }>
  | undefined => {
  if (value === undefined) return undefined // Legacy captures remain readable.
  const parsed = pythonRandomStateSchema.safeParse(value)
  if (!parsed.success) throw new Error('Captured Python random state is invalid.')
  if (parsed.data.state === 'unavailable')
    throw new Error(`Captured Python random state cannot be restored: ${parsed.data.reason}.`)
  return parsed.data
}
