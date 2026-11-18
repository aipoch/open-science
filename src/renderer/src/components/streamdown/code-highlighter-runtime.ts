import { createCodePlugin } from '@streamdown/code'

// These palettes also keep small syntax tokens readable on the Notebook inset surface.
export const code = createCodePlugin({
  themes: ['github-light-high-contrast', 'github-dark-high-contrast']
})
