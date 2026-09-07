import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  isSessionSizeLimitError,
  SESSION_SIZE_LIMIT_ERROR_CODE
} from '../../shared/session-persistence'

const preserveSessionSizeLimitCode = async <Result>(
  operation: () => Promise<Result>
): Promise<Result> => {
  try {
    return await operation()
  } catch (error) {
    if (isSessionSizeLimitError(error)) {
      throw new ApplicationCommandError(
        SESSION_SIZE_LIMIT_ERROR_CODE,
        error instanceof Error ? error.message : 'Session exceeds the persistence limit.'
      )
    }
    throw error
  }
}

export { preserveSessionSizeLimitCode }
