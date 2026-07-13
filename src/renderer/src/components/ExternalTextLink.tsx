import { ArrowUpRight } from 'lucide-react'

import { cn } from '@/lib/utils'

// Inline external link: an underlined label trailed by an up-right arrow, signaling that it opens
// outside the app in the system browser. Shared so every "leaves the app" link reads the same.
// Font size is inherited from the surrounding text; pass className to tune color or size per context.
const ExternalTextLink = ({
  href,
  children,
  className,
  'aria-label': ariaLabel
}: {
  href: string
  children: React.ReactNode
  className?: string
  'aria-label'?: string
}): React.JSX.Element => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    aria-label={ariaLabel}
    className={cn(
      'inline-flex items-center gap-0.5 font-medium text-primary underline underline-offset-2 transition-colors hover:text-primary/80',
      className
    )}
  >
    {children}
    <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
  </a>
)

export { ExternalTextLink }
