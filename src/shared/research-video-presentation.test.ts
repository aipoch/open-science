import { expect, it } from 'vitest'
import { researchVideoFilename } from './research-video-presentation'

it.each([
  ['Where Does the Heat Go?', 'Where-Does-the-Heat-Go'],
  ['  Heat: alpha/beta\\gamma?  ', 'Heat-alpha-beta-gamma'],
  ['城市降雨研究', '城市降雨研究'],
  ['CON', '_CON'],
  ['LPT1.study', '_LPT1.study'],
  ['', 'Research-explanation'],
  ['...', 'conversation']
])('uses the same portable title for HTML and MP4: %s', (title, stem) => {
  expect(researchVideoFilename(title, 'html')).toBe(`${stem}.html`)
  expect(researchVideoFilename(title, 'mp4')).toBe(`${stem}.mp4`)
})

it('bounds multibyte filenames without splitting Unicode characters', () => {
  const filename = researchVideoFilename('🧪研究'.repeat(100), 'html')
  expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(225)
  expect(filename).not.toContain('�')
  expect(filename.endsWith('.html')).toBe(true)
})
