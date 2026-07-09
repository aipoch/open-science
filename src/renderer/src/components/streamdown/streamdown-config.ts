import type { AllowedTags } from 'streamdown'

/** Inline SVG tags for agent-generated charts (bar/line/pie). */
const AGENT_SVG_ALLOWED_TAGS: AllowedTags = {
  svg: ['viewBox', 'width', 'height', 'xmlns', 'fill', 'stroke', 'role', 'aria-label'],
  g: ['transform', 'fill', 'stroke', 'opacity', 'class', 'id'],
  rect: [
    'x',
    'y',
    'width',
    'height',
    'fill',
    'stroke',
    'stroke-width',
    'rx',
    'ry',
    'opacity',
    'transform'
  ],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'opacity'],
  ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'opacity'],
  path: ['d', 'fill', 'stroke', 'stroke-width', 'opacity', 'transform'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width', 'opacity'],
  polygon: ['points', 'fill', 'stroke', 'stroke-width', 'opacity'],
  text: [
    'x',
    'y',
    'fill',
    'font-size',
    'font-family',
    'font-weight',
    'text-anchor',
    'dominant-baseline',
    'transform',
    'opacity'
  ],
  tspan: ['x', 'y', 'fill', 'font-size', 'font-family', 'text-anchor', 'dominant-baseline'],
  defs: [],
  clippath: ['id'],
  lineargradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
  radialgradient: ['id', 'cx', 'cy', 'r', 'gradientUnits'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  title: [],
  desc: [],
  use: ['href', 'x', 'y', 'width', 'height']
}

/** Media / semantic HTML common in agent replies (ChatGPT, Claude, Cursor, etc.). */
const AGENT_MEDIA_AND_SEMANTIC_TAGS: AllowedTags = {
  aside: ['data-agent-alert'],
  figure: [],
  figcaption: [],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  video: ['controls', 'src', 'width', 'height', 'poster', 'preload', 'playsinline'],
  audio: ['controls', 'src', 'preload'],
  source: ['src', 'type'],
  track: ['kind', 'src', 'srclang', 'label', 'default'],
  dl: [],
  dt: [],
  dd: [],
  ruby: [],
  rt: [],
  rp: [],
  time: ['datetime'],
  span: ['class'],
  hr: []
}

/** HTML tags allowed through Streamdown sanitization for agent output. */
const AGENT_ALLOWED_TAGS: AllowedTags = {
  ...AGENT_SVG_ALLOWED_TAGS,
  ...AGENT_MEDIA_AND_SEMANTIC_TAGS,
  mark: [],
  sub: [],
  sup: [],
  details: [],
  summary: [],
  kbd: [],
  abbr: ['title'],
  del: [],
  ins: [],
  cite: [],
  q: [],
  var: [],
  samp: [],
  small: [],
  u: [],
  br: []
}

/** Toolbar controls for tables, code blocks, and mermaid diagrams. */
const AGENT_CONTROLS = {
  table: {
    copy: true,
    download: true,
    fullscreen: true
  },
  code: {
    copy: true,
    download: true
  },
  mermaid: {
    copy: true,
    download: true,
    fullscreen: true,
    panZoom: false
  }
} as const

export { AGENT_ALLOWED_TAGS, AGENT_CONTROLS }
