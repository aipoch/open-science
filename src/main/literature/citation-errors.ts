import { CitationStyleError } from '@aipoch/literature-citations'
import { ApplicationCommandError } from '../../shared/application-command-contract'

/** Translate package errors at the application transport boundary. */
export async function withCitationStyleErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CitationStyleError)
      throw new ApplicationCommandError(error.code, error.message, error.parameters)
    throw error
  }
}
