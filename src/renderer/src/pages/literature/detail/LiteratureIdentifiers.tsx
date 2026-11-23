import { ExternalTextLink } from '@/components/ExternalTextLink'
import { cn } from '@/lib/utils'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue
} from '@aipoch/literature-citations/contracts'

export function LiteratureIdentifiers({
  identifiers,
  className
}: {
  identifiers: LiteratureItemInput['identifiers']
  className?: string
}): React.JSX.Element | null {
  if (!identifiers.length) return null
  return (
    <dl className={cn('flex flex-wrap gap-x-5 gap-y-2', className)}>
      {identifiers.map((identifier) => {
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
  )
}
