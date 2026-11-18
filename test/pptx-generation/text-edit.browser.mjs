// Run from the repository root: node test/pptx-generation/text-edit.browser.mjs
// Uses Playwright Chromium, or CHROME_PATH when supplied.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(process.cwd() + '/package.json')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PptxViewer } from '@aiden0z/pptx-renderer';
import { applyOperations, readOutline } from './src/shared/pptx-edit';
import { createDeckFixture } from './src/shared/pptx-edit/pptx-fixture.test-support';
import { measureTextFrame } from './src/renderer/src/pages/workspace/previews/pptx-text-frame';
import { readSlideBox } from './src/renderer/src/office-preview/office-preview-slide-view';
import { frameToScreen } from './src/renderer/src/pages/workspace/previews/pptx-edit-geometry';
import { PptxRichTextEditor } from './src/renderer/src/pages/workspace/previews/PptxRichTextEditor';
window.checkPptx = async (sizePt, zoom) => {
 const paragraphs = [{runs:[{text:'New text',sizePt,fontFamily:'Arial'}]}];
 const size = measureTextFrame(paragraphs, 6858000);
 const original = applyOperations(createDeckFixture(), [{op:'addTextbox', slideId:256, x:2286000,y:1285875,w:4572000,h:857250,paragraphs:[{runs:[{text:'New text',sizePt:18,fontFamily:'Arial'}]}]}]).bytes;
 const shapeId=readOutline(original).slides[0].shapes.at(-1).shapeId;
 const bytes=applyOperations(original,[{op:'setText',slideId:256,shapeId,paragraphs,frame:{x:2286000,y:1285875,...size}}]).bytes;
 const outline = readOutline(bytes);
 const shape = outline.slides[0].shapes.at(-1);
 const stage = document.querySelector('.pptx-review-stage');
 stage.replaceChildren();
 const viewer = new PptxViewer(stage,{pdfjs:false});
 await viewer.open(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),{renderMode:'slide'});
 const wrapper = stage.firstElementChild;
 const slide = wrapper.firstElementChild;
 wrapper.style.width = viewer.slideWidth*zoom+'px';
 wrapper.style.height = viewer.slideHeight*zoom+'px';
 slide.style.transform = 'scale('+zoom+')';
 slide.style.transformOrigin = 'top left';
 const box = readSlideBox(document);
 const expected = frameToScreen(shape.frame,outline.slideSize,box);
 const span = [...stage.querySelectorAll('span')].find(e=>e.textContent==='New text');
 const rect = span.getBoundingClientRect();
 const chain=[]; let node=span;
 while(node && node!==stage) {chain.push({tag:node.tagName,style:node.getAttribute('style'),rect:node.getBoundingClientRect().toJSON()});node=node.parentElement;}
 const fits=rect.left>=expected.left-1 && rect.top>=expected.top-1 && rect.right<=expected.left+expected.width+1 && rect.bottom<=expected.top+expected.height+1;
 const result={sizePt,zoom,fits,expected,actual:rect.toJSON(),chain};
 viewer.destroy();
 return result;
};
window.mountEditor=()=>createRoot(document.querySelector('#editor')).render(React.createElement(PptxRichTextEditor,{label:'Shape text',initial:[{runs:[{text:'New text',sizePt:18}]}],onApply:(text,paragraphs)=>{window.applied=paragraphs},onCancel:()=>{}}));
`,
    resolveDir: process.cwd(),
    loader: 'tsx'
  },
  jsx: 'automatic',
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"' },
  logLevel: 'silent'
})
const chromePath =
  process.env.CHROME_PATH ??
  (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined)
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {})
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.setContent(
    `<style>*{box-sizing:border-box}body{margin:0;font-family:Arial} .pptx-review-stage{display:flex;align-items:flex-start;justify-content:safe center;padding:16px;overflow:auto;width:1100px;height:700px}.pptx-review-stage>*{flex:0 0 auto} #editor{position:relative;min-height:300px}</style><div class="pptx-review-thumbnail" data-slide="0" data-active></div><div class="pptx-review-content"><div class="pptx-review-stage"></div><aside>Notes</aside></div><div id="editor"></div>`
  )
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  for (const size of [18, 36, 72])
    for (const zoom of [0.5, 1, 1.25]) {
      const result = await page.evaluate(([s, z]) => window.checkPptx(s, z), [size, zoom])
      if (!result.fits) throw new Error(JSON.stringify(result))
      else console.log(JSON.stringify({ size, zoom, fits: true }))
    }
  await page.evaluate(() => window.mountEditor())
  const input = page.getByRole('spinbutton', { name: 'Font size' })
  await input.fill('')
  if ((await input.inputValue()) !== '') throw new Error('Cannot clear font size')
  await input.fill('72')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  const applied = await page.evaluate(() => window.applied)
  if (applied[0].runs[0].sizePt !== 72) throw new Error('Font size not saved')
  console.log('font size clear/type/apply: passed')
} finally {
  await browser.close()
}
