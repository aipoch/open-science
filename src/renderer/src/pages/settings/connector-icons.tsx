import { Terminal } from 'lucide-react'

// Blocks glyph for the "Connectors" left-nav item: three squares forming an L plus a smaller
// detached module top-right (a connectable block). Outline style to match the other nav icons.
export const ConnectorsNavIcon = ({ className }: { className?: string }): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.7" />
    <rect x="3" y="13" width="8" height="8" rx="1.7" />
    <rect x="13" y="13" width="8" height="8" rx="1.7" />
    <rect x="14.5" y="2" width="6.5" height="6.5" rx="1.5" />
  </svg>
)

// Per-connector tile: a rounded white card (border + shadow) holding a terminal glyph, used in the
// connector list rows and the detail header. `size` is the tile's edge length in px.
export const ConnectorGlyph = ({
  size = 24,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element => (
  <span
    aria-hidden="true"
    className={
      'inline-flex shrink-0 items-center justify-center border border-border bg-card text-muted-foreground shadow-sm ' +
      (className ?? '')
    }
    style={{ width: size, height: size, borderRadius: Math.round(size * 0.27) }}
  >
    <Terminal size={Math.round(size * 0.58)} strokeWidth={2} aria-hidden="true" />
  </span>
)
