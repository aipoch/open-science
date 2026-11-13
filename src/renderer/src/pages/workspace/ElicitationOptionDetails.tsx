import { useTranslation } from 'react-i18next'
import type { ElicitationOption } from '../../../../shared/elicitation'

const ElicitationOptionDetails = ({
  option
}: {
  option: Pick<ElicitationOption, 'description' | 'pros' | 'cons'>
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <>
      {option.description ? (
        <span
          data-testid="elicitation-description"
          className="mt-px block whitespace-pre-wrap break-words text-xs leading-4 text-text-100"
        >
          {option.description}
        </span>
      ) : null}
      {option.pros ? (
        <span className="mt-1 block whitespace-pre-wrap break-words text-xs leading-4 text-text-100">
          <span className="font-medium">
            {t('Pros')}
            {': '}
          </span>
          {option.pros}
        </span>
      ) : null}
      {option.cons ? (
        <span className="mt-1 block whitespace-pre-wrap break-words text-xs leading-4 text-text-100">
          <span className="font-medium">
            {t('Cons')}
            {': '}
          </span>
          {option.cons}
        </span>
      ) : null}
    </>
  )
}

export { ElicitationOptionDetails }
