import { useTranslation } from 'react-i18next'
import { JournalAttributes } from '../JournalAttributes'
import { LiteratureSources } from '../LiteratureSources'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import type { LiteratureItemType, LiteratureItemView } from '../../../../../shared/literature'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue
} from '../../../../../shared/literature'

import {
  fullCreatorLabel,
  getExternalLiteratureUrl,
  typeFieldText
} from '../literature-item-display'

import { CollapsibleAbstract, CollapsibleAuthors } from './LiteratureDetailText'

export function LiteratureBibliographicDetails({
  selectedItem,
  itemTypeLabels
}: {
  selectedItem: LiteratureItemView
  itemTypeLabels: Record<LiteratureItemType, string>
}): React.JSX.Element {
  const { t } = useTranslation()
  const selectedItemExternalUrl = getExternalLiteratureUrl(selectedItem.item.url)
  return (
    <>
      {' '}
      {fullCreatorLabel(selectedItem.item) ? (
        <section className="py-4">
          <h3 className="font-medium">{t('Authors')}</h3>
          <CollapsibleAuthors text={fullCreatorLabel(selectedItem.item)} />
        </section>
      ) : null}
      {selectedItem.item.abstract ? (
        <section className="py-4">
          <h3 className="font-medium">{t('Abstract')}</h3>
          <CollapsibleAbstract text={selectedItem.item.abstract} />
        </section>
      ) : null}
      <JournalAttributes item={selectedItem.item} itemId={selectedItem.id} detail />
      <section className="py-4">
        <h3 className="font-medium">{t('Publication metadata')}</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {[
            [t('Reference type'), itemTypeLabels[selectedItem.item.itemType]],
            [t('Year'), selectedItem.item.issuedYear?.toString() ?? ''],
            [t('Publication'), selectedItem.item.containerTitle],
            [t('Publisher'), typeFieldText(selectedItem.item, 'publisher')],
            [t('Volume'), typeFieldText(selectedItem.item, 'volume')],
            [t('Issue'), typeFieldText(selectedItem.item, 'issue')],
            [t('Pages'), typeFieldText(selectedItem.item, 'pages')],
            [t('Language'), selectedItem.item.language]
          ]
            .filter((entry): entry is [string, string] => Boolean(entry[1]))
            .map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 truncate" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          {selectedItemExternalUrl ? (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t('URL')}</dt>
              <dd className="mt-0.5 truncate" title={selectedItemExternalUrl.href}>
                <ExternalTextLink
                  href={selectedItemExternalUrl.href}
                  aria-label={`${t('URL')}: ${selectedItemExternalUrl.href}`}
                  className="max-w-full truncate"
                >
                  {selectedItemExternalUrl.href}
                </ExternalTextLink>
              </dd>
            </div>
          ) : null}
        </dl>
        {selectedItem.item.identifiers.length > 0 ? (
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-border-300/70 pt-3">
            {selectedItem.item.identifiers.map((identifier) => {
              const value = normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value)
              const href = createLiteratureIdentifierUrl(identifier.scheme, value)
              return (
                <div
                  key={`${identifier.scheme}:${identifier.value}`}
                  className="flex min-w-0 items-baseline gap-2"
                >
                  <dt className="text-xs uppercase text-muted-foreground">{identifier.scheme}</dt>
                  <dd className="min-w-0 break-all">
                    {href ? (
                      <ExternalTextLink
                        href={href}
                        aria-label={`${identifier.scheme.toUpperCase()}: ${value}`}
                      >
                        {value}
                      </ExternalTextLink>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        ) : null}
      </section>
      <LiteratureSources
        key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
        itemId={selectedItem.id}
      />
    </>
  )
}
