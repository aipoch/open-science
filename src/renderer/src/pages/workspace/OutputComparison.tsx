import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button'
import { ScientificComparisonFields, ScientificComparisonDetails } from './ScientificComparison'
import { ComparisonFieldLabel } from './ComparisonFieldLabel'
import {
  outputComparisonPolicySchema,
  type OutputComparisonPolicy,
  type OutputComparisonReport
} from '../../../../shared/output-comparison'

const scientificPolicyFromForm = (form: FormData): unknown => {
  const text = (key: string): string => String(form.get(key) ?? '').trim()
  const number = (key: string): number => (text(key) ? Number(text(key)) : NaN)
  if (form.get('scientificKind') === 'cell-clusters')
    return {
      kind: 'cell-clusters',
      cellColumn: text('cellColumn'),
      clusterColumn: text('clusterColumn'),
      minimumAdjustedRand: number('minimumAdjustedRand')
    }
  if (form.get('scientificKind') === 'differential-expression')
    return {
      kind: 'differential-expression',
      geneColumn: text('geneColumn'),
      effectColumn: text('effectColumn'),
      adjustedPColumn: text('adjustedPColumn'),
      contrast: text('contrast'),
      adjustedPThreshold: number('adjustedPThreshold'),
      minimumAbsoluteEffect: number('minimumAbsoluteEffect'),
      minimumGeneJaccard: number('minimumGeneJaccard'),
      minimumDirectionAgreement: number('minimumDirectionAgreement')
    }
  return undefined
}

export const OutputComparisonSettings = ({
  value,
  onChange,
  onPendingChange,
  disabled,
  overlayClassName
}: {
  value: OutputComparisonPolicy
  onChange: (value: OutputComparisonPolicy) => void
  onPendingChange: (pending: boolean) => void
  disabled?: boolean
  overlayClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const id = useId()
  const markPending = (): void => {
    setPending(true)
    onPendingChange(true)
  }
  return (
    <details className="mt-3 text-xs text-text-200">
      <summary className="cursor-pointer py-1">{t('Comparison rules')}</summary>
      <p className="my-2 text-text-300">
        {t('Byte checks remain exact. Content comparisons use the rules below.')}
      </p>
      <form
        noValidate
        key={JSON.stringify(value)}
        className="grid grid-cols-1 gap-3 @lg:grid-cols-2"
        onInput={(event) => {
          markPending()
          const input = event.target
          if (input instanceof HTMLInputElement && errors[input.name]) {
            setErrors((current) => {
              const next = { ...current }
              delete next[input.name]
              return next
            })
          }
        }}
        onChange={markPending}
        onSubmit={(event) => {
          event.preventDefault()
          const element = event.currentTarget
          const form = new FormData(element)
          const number = (key: string): number =>
            String(form.get(key) ?? '').trim() ? Number(form.get(key)) : NaN
          const names = (key: string): string[] =>
            String(form.get(key) ?? '')
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          const parsed = outputComparisonPolicySchema.safeParse({
            schemaVersion: 1,
            ...(scientificPolicyFromForm(form)
              ? { scientific: scientificPolicyFromForm(form) }
              : {}),
            table: {
              keys: names('keys'),
              numericColumns: names('numeric'),
              absoluteTolerance: number('absolute'),
              relativeTolerance: number('relative')
            },
            image: {
              maxRmse: number('rmse'),
              maxChangedPixelRatio: number('pixels') / 100
            }
          })
          const nextErrors: Record<string, string> = {}
          if (!parsed.success) {
            const fields: Record<string, string> = {
              keys: 'keys',
              numericColumns: 'numeric',
              absoluteTolerance: 'absolute',
              relativeTolerance: 'relative',
              maxRmse: 'rmse',
              maxChangedPixelRatio: 'pixels'
            }
            for (const issue of parsed.error.issues) {
              const key = String(issue.path[1])
              const name = fields[key] ?? key
              const input = element.elements.namedItem(name)
              if (!(input instanceof HTMLInputElement) || nextErrors[name]) continue
              nextErrors[name] =
                name === 'keys' || name === 'numeric'
                  ? t('Use unique column names: at most 64 names, each up to 256 characters.')
                  : name === 'adjustedPThreshold'
                    ? t('Enter a number greater than 0 and less than 1.')
                    : input.type === 'number'
                      ? t('Enter a finite number from {{min}} to {{max}}.', {
                          min: input.min,
                          max: input.max
                        })
                      : t('Enter 1 to 256 characters.')
            }
          }
          setErrors(nextErrors)
          if (!parsed.success) {
            const first = Array.from(element.elements).find(
              (input) => input instanceof HTMLInputElement && nextErrors[input.name]
            )
            if (first instanceof HTMLInputElement) first.focus()
          }
          if (parsed.success) {
            onChange(parsed.data)
            setPending(false)
            onPendingChange(false)
          }
        }}
      >
        <div className="grid gap-1">
          <ComparisonFieldLabel
            htmlFor={`${id}-keys`}
            error={errors.keys}
            overlayClassName={overlayClassName}
            label={t('Row keys (comma-separated)')}
            help={t(
              'Column names that uniquely identify each row, e.g. sample, gene. Leave blank to compare rows in their saved order.'
            )}
          />
          <input
            id={`${id}-keys`}
            name="keys"
            aria-invalid={!!errors.keys}
            aria-describedby={errors.keys ? `${id}-keys-error` : undefined}
            defaultValue={value.table.keys.join(', ')}
            disabled={disabled}
            className="min-w-0 w-full rounded border border-border-300 bg-bg-000 px-2 py-1.5"
          />
        </div>
        <div className="grid gap-1">
          <ComparisonFieldLabel
            htmlFor={`${id}-numeric`}
            error={errors.numeric}
            overlayClassName={overlayClassName}
            label={t('Numeric columns (comma-separated)')}
            help={t(
              'CSV/TSV columns to compare with numeric tolerances. Other columns compare exactly. Leave blank to use exact comparison for every column.'
            )}
          />
          <input
            id={`${id}-numeric`}
            name="numeric"
            aria-invalid={!!errors.numeric}
            aria-describedby={errors.numeric ? `${id}-numeric-error` : undefined}
            defaultValue={value.table.numericColumns.join(', ')}
            disabled={disabled}
            className="min-w-0 w-full rounded border border-border-300 bg-bg-000 px-2 py-1.5"
          />
        </div>
        {(
          [
            [
              'absolute',
              t('Absolute tolerance'),
              value.table.absoluteTolerance,
              1e12,
              t(
                'Allowed absolute difference for selected numeric columns, added to the relative allowance. For example, 0.01 allows an absolute difference of 0.01.'
              )
            ],
            [
              'relative',
              t('Relative tolerance'),
              value.table.relativeTolerance,
              1e12,
              t(
                'Allowance relative to the original value, added to absolute tolerance: value × |original|. Enter 0.01 for 1%; 0 adds no relative allowance.'
              )
            ],
            [
              'rmse',
              t('Maximum pixel RMSE'),
              value.image.maxRmse,
              255,
              t(
                'Maximum root mean square difference across RGBA channels, from 0 to 255. Zero requires identical pixels. Both image limits must pass.'
              )
            ],
            [
              'pixels',
              t('Maximum changed pixels (%)'),
              value.image.maxChangedPixelRatio * 100,
              100,
              t(
                'Maximum percentage of pixels with any changed RGBA channel, from 0 to 100. Zero allows none. Image dimensions must match.'
              )
            ]
          ] as const
        ).map(([name, label, defaultValue, max, help]) => (
          <div key={name} className="grid gap-1">
            <ComparisonFieldLabel
              htmlFor={`${id}-${name}`}
              error={errors[name]}
              label={label}
              help={help}
              overlayClassName={overlayClassName}
            />
            <input
              id={`${id}-${name}`}
              name={name}
              aria-invalid={!!errors[name]}
              aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
              type="number"
              min={0}
              max={max}
              step="any"
              required
              defaultValue={defaultValue}
              disabled={disabled}
              className="min-w-0 w-full rounded border border-border-300 bg-bg-000 px-2 py-1.5"
            />
          </div>
        ))}
        <p className="text-text-300 @lg:col-span-2">
          {t(
            'Columns match by name. Rows keep their order unless keys are specified. Other values compare exactly.'
          )}
        </p>
        <ScientificComparisonFields
          value={value.scientific}
          disabled={disabled}
          onChange={markPending}
          overlayClassName={overlayClassName}
          errors={errors}
        />
        <Button
          type="submit"
          size="sm"
          variant={pending ? 'default' : 'outline'}
          disabled={disabled || !pending}
          className="h-auto min-h-7 max-w-full justify-self-start whitespace-normal py-1"
        >
          {t('Apply comparison rules')}
        </Button>
      </form>
    </details>
  )
}

export const OutputComparisonDetails = ({
  report
}: {
  report: OutputComparisonReport
}): React.JSX.Element => {
  const { t } = useTranslation()
  const number = (value: number): string =>
    value.toLocaleString(undefined, { maximumSignificantDigits: 5 })
  return (
    <details
      className="mt-2 rounded border border-border-300/60 p-2 text-xs text-text-200"
      data-content-comparison={report.outcome}
    >
      <summary className="cursor-pointer font-medium">
        {report.outcome === 'equal'
          ? t('Decoded content is identical')
          : report.outcome === 'within-tolerance'
            ? t('Content is within the selected tolerance')
            : report.outcome === 'different'
              ? t('Content differs')
              : t('Content comparison unavailable')}
      </summary>
      {report.reason ? (
        <p className="mt-2 text-text-300">
          {report.reason === 'budget-exceeded'
            ? t('Content exceeds the comparison limit.')
            : report.reason === 'shape-mismatch'
              ? t('Image dimensions differ.')
              : report.reason === 'schema-mismatch'
                ? t('Table columns differ.')
                : report.reason === 'duplicate-key'
                  ? t('Row keys are not unique.')
                  : report.reason === 'missing-key'
                    ? t('A selected column or row key is missing.')
                    : report.reason === 'unsupported-format'
                      ? t('This content format is not supported for comparison.')
                      : t('Content could not be parsed or compared.')}
        </p>
      ) : null}
      {report.image ? (
        <dl className="mt-2 grid grid-cols-2 gap-1 tabular-nums">
          <dt>{t('Changed pixels')}</dt>
          <dd>{number(report.image.changedPixelRatio * 100)}%</dd>
          <dt>{t('Pixel RMSE')}</dt>
          <dd>{number(report.image.rmse)}</dd>
          <dt>{t('Maximum pixel difference')}</dt>
          <dd>{number(report.image.maxDifference)}</dd>
          {report.image.ssim !== undefined ? (
            <>
              <dt>{t('Structural similarity')}</dt>
              <dd>{number(report.image.ssim)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {report.image?.bitDepth === 16 ? (
        <p className="mt-2 text-text-300">
          {t('16-bit samples retain their precision. Error values use a 0–255 scale.')}
        </p>
      ) : null}
      {report.table ? (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-1 tabular-nums">
            <dt>{t('Changed cells')}</dt>
            <dd>{report.table.changedCells}</dd>
            <dt>{t('Outside tolerance')}</dt>
            <dd>{report.table.outsideTolerance}</dd>
            <dt>{t('Missing rows')}</dt>
            <dd>{report.table.missingRows}</dd>
            <dt>{t('Added rows')}</dt>
            <dd>{report.table.addedRows}</dd>
            <dt>{t('Maximum absolute error')}</dt>
            <dd>{number(report.table.maxAbsoluteError)}</dd>
          </dl>
          {report.table.differences.length ? (
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th>{t('Row')}</th>
                    <th>{t('Column')}</th>
                    <th>{t('Original output')}</th>
                    <th>{t('Reproduced output')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.table.differences.map((difference, index) => (
                    <tr key={index} className="border-t border-border-300/50">
                      <td className="max-w-36 break-words py-1">{difference.row}</td>
                      <td>{difference.column}</td>
                      <td className="max-w-48 break-words">{difference.expected}</td>
                      <td className="max-w-48 break-words">{difference.actual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {report.table.detailsTruncated ? (
            <p className="mt-2 text-text-300">
              {t('Showing the first 100 changed cells. Totals include the complete comparison.')}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="mt-2 text-text-300">
        {t('These rules compare saved outputs; they do not establish scientific equivalence.')}
      </p>
      {report.scientific && report.policy.scientific ? (
        <ScientificComparisonDetails report={report.scientific} policy={report.policy.scientific} />
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-1 tabular-nums">
        <dt>{t('Row keys (comma-separated)')}</dt>
        <dd className="break-words">{report.policy.table.keys.join(', ') || '—'}</dd>
        <dt>{t('Numeric columns (comma-separated)')}</dt>
        <dd className="break-words">{report.policy.table.numericColumns.join(', ') || '—'}</dd>
        <dt>{t('Absolute tolerance')}</dt>
        <dd>{report.policy.table.absoluteTolerance}</dd>
        <dt>{t('Relative tolerance')}</dt>
        <dd>{report.policy.table.relativeTolerance}</dd>
        <dt>{t('Maximum pixel RMSE')}</dt>
        <dd>{report.policy.image.maxRmse}</dd>
        <dt>{t('Maximum changed pixels (%)')}</dt>
        <dd>{report.policy.image.maxChangedPixelRatio * 100}</dd>
      </dl>
    </details>
  )
}
