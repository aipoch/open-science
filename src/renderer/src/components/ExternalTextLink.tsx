import { ArrowUpRight } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '@/lib/utils'

// Inline external link: an underlined label trailed by an up-right arrow, signaling that it opens
// outside the app in the system browser. Shared so every "leaves the app" link reads the same.
// Font size is inherited from the surrounding text; pass className to tune color or size per context.
const ExternalTextLink = ({
  href,
  children,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'target' | 'rel'> & {
  href: string
  children: React.ReactNode
}): React.JSX.Element => (
  <a
    {...props}
    href={href}
    target="_blank"
    rel="noreferrer"
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
