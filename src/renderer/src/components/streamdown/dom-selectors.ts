export const STREAMDOWN_TABLE_FULLSCREEN_SELECTOR = '[data-streamdown="table-fullscreen"]'

export const STREAMDOWN_MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]'

export const STREAMDOWN_MERMAID_FULLSCREEN_SELECTOR =
  'body > div.fixed.inset-0.z-50.flex.items-center.justify-center[role="button"]:not([data-streamdown])'

export const STREAMDOWN_FULLSCREEN_SELECTOR = `${STREAMDOWN_MERMAID_FULLSCREEN_SELECTOR}, ${STREAMDOWN_TABLE_FULLSCREEN_SELECTOR}`
