export function classificationFailureText(
  t: import('i18next').TFunction,
  failure?: import('../../../../shared/classification').ClassificationFailureCategory
): string {
  switch (failure) {
    case 'auth':
      return t('Authentication failed. Check the classification service credentials.')
    case 'rate-limit':
      return t('The classification service is busy. Retry later.')
    case 'timeout':
      return t('Classification timed out. Check the connection and retry.')
    case 'network':
      return t('Cannot reach the classification service. Check the connection and retry.')
    case 'invalid-response':
      return t(
        'The service returned an unsupported classification response. Check the model configuration.'
      )
    case 'configuration':
      return t('The rule, evidence or model configuration changed. Update the collection again.')
    case 'service':
      return t('The classification service is unavailable. Retry later.')
    default:
      return t('Evaluation failed. Saved evidence is preserved; retry this reference.')
  }
}
