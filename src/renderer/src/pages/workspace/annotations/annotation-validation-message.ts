import type { TFunction } from 'i18next'

import type { AnnotationValidationError } from '../../../../../shared/annotations'

export const annotationValidationMessage = (
  error: AnnotationValidationError,
  t: TFunction
): string => {
  switch (error) {
    case 'too-many':
      return t('You can add up to 10 annotations to one message.')
    case 'quote-too-long':
      return t('The selected quote is too long.')
    case 'note-too-long':
      return t('The annotation note is too long.')
    case 'payload-too-large':
      return t('The annotations are too large to send together.')
    default:
      return t('This annotation could not be added.')
  }
}
