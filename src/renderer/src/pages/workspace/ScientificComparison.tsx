import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ComparisonFieldLabel } from './ComparisonFieldLabel'
import type {
  ScientificComparisonPolicy,
  ScientificComparisonReport
} from '../../../../shared/output-comparison'

export const ScientificComparisonFields = ({
  value,
  disabled,
  onChange,
  overlayClassName,
  errors = {}
}: {
  value?: ScientificComparisonPolicy
  disabled?: boolean
  onChange: () => void
  overlayClassName?: string
  errors?: Record<string, string>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [kind, setKind] = useState(value?.kind ?? 'none')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const id = useId()
  const fields: Array<[string, string, string, 'text' | 'number', number?, number?]> =
    kind === 'differential-expression'
      ? [
          [
            'geneColumn',
            t('Gene identifier column'),
            t(
              'Column containing unique gene IDs, e.g. gene. Both tables must contain the same IDs, without duplicates or missing IDs.'
            ),
            'text'
          ],
          [
            'effectColumn',
            t('Log2 fold-change column'),
            t(
              'Column containing signed log2 fold changes, e.g. log2FoldChange. Both results must use the same comparison direction.'
            ),
            'text'
          ],
          [
            'adjustedPColumn',
            t('Adjusted p-value column'),
            t(
              'Column containing adjusted p-values, e.g. padj. Values must be between 0 and 1. No p-value adjustment is performed here.'
            ),
            'text'
          ],
          [
            'contrast',
            t('Contrast (numerator / denominator)'),
            t(
              'Record the comparison direction, e.g. treated / control. This label records your choice; it does not reverse or recalculate fold changes.'
            ),
            'text'
          ],
          [
            'adjustedPThreshold',
            t('Adjusted p-value threshold'),
            t(
              'A gene must have an adjusted p-value strictly below this threshold and meet the effect threshold. Enter a value strictly between 0 and 1.'
            ),
            'number',
            0,
            1
          ],
          [
            'minimumAbsoluteEffect',
            t('Minimum absolute log2 fold change'),
            t(
              'Minimum absolute log2 fold change for a significant gene. A value of 1 requires at least a twofold increase or decrease; 0 adds no effect-size cutoff.'
            ),
            'number',
            0,
            1e12
          ],
          [
            'minimumGeneJaccard',
            t('Minimum gene-set Jaccard'),
            t(
              'Required overlap of significant gene sets: intersection divided by union. Enter 0 to 1; 1 requires identical sets. At least one shared significant gene is required.'
            ),
            'number',
            0,
            1
          ],
          [
            'minimumDirectionAgreement',
            t('Minimum direction agreement'),
            t(
              'Required fraction of shared significant genes with the same fold-change sign. Enter 0 to 1; 0.95 means at least 95% agreement.'
            ),
            'number',
            0,
            1
          ]
        ]
      : kind === 'cell-clusters'
        ? [
            [
              'cellColumn',
              t('Cell identifier column'),
              t(
                'Column containing unique cell IDs, e.g. barcode. Both tables must contain the same cells, without duplicates or missing IDs.'
              ),
              'text'
            ],
            [
              'clusterColumn',
              t('Cluster label column'),
              t(
                'Column containing one cluster label per cell. Cluster names may differ between results; comparison uses cell membership, not label text.'
              ),
              'text'
            ],
            [
              'minimumAdjustedRand',
              t('Minimum adjusted Rand index'),
              t(
                'Minimum agreement between cell partitions after adjusting for chance, from -1 to 1. A value of 1 requires identical partitions, even if labels differ.'
              ),
              'number',
              -1,
              1
            ]
          ]
        : []
  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 grid-cols-1 gap-3 border-t border-border-300/60 pt-3 @lg:col-span-2 @lg:grid-cols-2"
    >
      <div className="grid gap-1 @lg:col-span-2">
        <ComparisonFieldLabel
          htmlFor={`${id}-kind`}
          overlayClassName={overlayClassName}
          label={t('Scientific comparison')}
          help={t(
            'Compare CSV/TSV results using differential-expression or cell-clustering criteria. None skips these additional criteria. Byte checks remain exact.'
          )}
        />
        <Select
          name="scientificKind"
          value={kind}
          disabled={disabled}
          onValueChange={(next) => {
            setKind(next)
            onChange()
          }}
        >
          <SelectTrigger id={`${id}-kind`} className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className={cn(
              'max-w-[calc(100vw-2rem)] [&_[data-slot=select-item]]:break-words [&_[data-slot=select-item]]:whitespace-normal',
              overlayClassName
            )}
          >
            <SelectItem value="none">{t('None')}</SelectItem>
            <SelectItem value="differential-expression">{t('Differential expression')}</SelectItem>
            <SelectItem value="cell-clusters">{t('Single-cell clusters')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {fields.map(([name, label, help, type, min, max]) => (
        <div className="grid gap-1" key={`${kind}:${name}`}>
          <ComparisonFieldLabel
            htmlFor={`${id}-${name}`}
            label={label}
            help={help}
            overlayClassName={overlayClassName}
            error={errors[name]}
          />
          <input
            id={`${id}-${name}`}
            name={name}
            aria-invalid={!!errors[name]}
            aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
            type={type}
            required
            step={type === 'number' ? 'any' : undefined}
            min={min}
            max={max}
            value={
              drafts[`${kind}:${name}`] ??
              (value && value.kind === kind && name in value
                ? String(Reflect.get(value, name))
                : '')
            }
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [`${kind}:${name}`]: event.target.value }))
            }
            className="min-w-0 w-full rounded border border-border-300 bg-bg-000 px-2 py-1.5"
          />
        </div>
      ))}
      {kind !== 'none' ? (
        <p className="text-text-300 @lg:col-span-2">
          {t(
            'Applies to CSV/TSV outputs. Specify identifiers and thresholds explicitly. Missing or duplicate identifiers cannot pass.'
          )}
        </p>
      ) : null}
    </fieldset>
  )
}

export const ScientificComparisonDetails = ({
  report,
  policy
}: {
  report: ScientificComparisonReport
  policy: ScientificComparisonPolicy
}): React.JSX.Element => {
  const { t } = useTranslation()
  const metrics: Array<[string, number | undefined]> =
    report.kind === 'cell-clusters'
      ? [[t('Adjusted Rand index'), report.adjustedRand]]
      : [
          [t('Original significant genes'), report.expectedSignificant],
          [t('Reproduced significant genes'), report.actualSignificant],
          [t('Common significant genes'), report.commonSignificant],
          [t('Gene-set Jaccard'), report.geneJaccard],
          [t('Direction agreement'), report.directionAgreement],
          [t('Changed missing values'), report.missingValueChanges]
        ]
  return (
    <section
      className="mt-3 border-t border-border-300/60 pt-2 text-xs"
      data-scientific-comparison={report.outcome}
    >
      <p className="font-medium">
        {t('Scientific comparison')} ·{' '}
        {report.kind === 'cell-clusters' ? t('Single-cell clusters') : t('Differential expression')}
      </p>
      <p className="mt-1">
        {report.outcome === 'meets-criteria'
          ? t('Selected criteria are met')
          : report.outcome === 'does-not-meet'
            ? t('Selected criteria are not met')
            : t('Scientific comparison unavailable')}
      </p>
      {report.reason ? (
        <p className="mt-1 text-text-300">
          {report.reason === 'no-comparable-results'
            ? t('There are not enough comparable results for this criterion.')
            : t('Check the identifier columns, missing values and selected result columns.')}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-1 tabular-nums">
        {[
          [t('Missing identifiers'), report.missingIdentifiers],
          [t('Added identifiers'), report.addedIdentifiers],
          ...metrics
        ].map(([label, value]) =>
          value === undefined ? null : (
            <div className="contents" key={String(label)}>
              <dt>{label}</dt>
              <dd>
                {typeof value === 'number' ? Number(value.toPrecision(6)).toLocaleString() : value}
              </dd>
            </div>
          )
        )}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer text-text-300">
          {t('Applied scientific criteria')}
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(policy, null, 2)}
        </pre>
      </details>
    </section>
  )
}
