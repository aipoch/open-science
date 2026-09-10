import { isSessionRevisionConflictError } from '../../src/shared/session-persistence'

// The operation must reload its snapshot before each save attempt.
export const retrySessionRevisionConflict = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isSessionRevisionConflictError(error) || attempt >= 5) throw error
    }
  }
}
