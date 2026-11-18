import type { TFunction } from 'i18next'
import type { CatalogErrorCode } from '@aipoch/providers'

/** Keep discovery failures distinct from inference/model availability failures. */
export function modelCatalogErrorMessage(code: CatalogErrorCode | undefined, t: TFunction): string {
  switch (code) {
    case 'unsupported':
      return t('Online refresh is not supported for this provider or region.')
    case 'missing-key':
      return t('Enter an API key to refresh the model list.')
    case 'missing-parameter':
      return t('Complete the catalog parameters before refreshing.')
    case 'authentication':
      return t('The API key was rejected. Check the key and region.')
    case 'permission':
      return t('This credential does not have permission to read the model catalog.')
    case 'rate-limit':
      return t('Too many catalog requests. Try again later.')
    case 'service':
      return t('The model catalog service is temporarily unavailable.')
    case 'not-found':
      return t('The configured model catalog address was not found.')
    case 'timeout':
      return t('The model catalog request timed out. Try again.')
    case 'network':
      return t('Could not connect to the model catalog. Check your network.')
    case 'resource-limit':
      return t('The model catalog exceeds the supported size limit.')
    case 'stale':
      return t('The provider changed while loading models. Try again.')
    case 'invalid-response':
      return t('The vendor returned an invalid or empty model catalog.')
    default:
      return t('Something went wrong. Try again.')
  }
}
