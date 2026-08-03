import type { CSSProperties } from 'react'

type IndicatorDotStyle = CSSProperties & {
  '--os-dot-angle': string
  '--os-dot-distance': string
  '--os-dot-radius': string
  '--os-dot-alpha': number
  '--os-dot-delay': string
}

const DOT_STYLES: IndicatorDotStyle[] = [
  {
    '--os-dot-angle': '0deg',
    '--os-dot-distance': '0.42',
    '--os-dot-radius': '0.12',
    '--os-dot-alpha': 0.9,
    '--os-dot-delay': '0s'
  },
  {
    '--os-dot-angle': '72deg',
    '--os-dot-distance': '0.36',
    '--os-dot-radius': '0.08',
    '--os-dot-alpha': 0.62,
    '--os-dot-delay': '-0.2s'
  },
  {
    '--os-dot-angle': '144deg',
    '--os-dot-distance': '0.44',
    '--os-dot-radius': '0.1',
    '--os-dot-alpha': 0.78,
    '--os-dot-delay': '-0.4s'
  },
  {
    '--os-dot-angle': '216deg',
    '--os-dot-distance': '0.34',
    '--os-dot-radius': '0.075',
    '--os-dot-alpha': 0.54,
    '--os-dot-delay': '-0.7s'
  },
  {
    '--os-dot-angle': '288deg',
    '--os-dot-distance': '0.4',
    '--os-dot-radius': '0.095',
    '--os-dot-alpha': 0.72,
    '--os-dot-delay': '-0.95s'
  }
]

const OpenScienceThinkingIndicator = (): React.JSX.Element => (
  <span
    data-testid="open-science-thinking-indicator"
    className="open-science-thinking-indicator text-text-300"
    aria-hidden="true"
  >
    {DOT_STYLES.map((style) => (
      <span
        key={style['--os-dot-angle']}
        className="open-science-thinking-indicator__dot"
        style={style}
      />
    ))}
  </span>
)

export { OpenScienceThinkingIndicator }
