import type { PdfReadingPosition } from './session-persistence'

export type PdfPreparationScope = 'auto' | 'current-page' | 'full-document'

const CURRENT_PAGE_INTENT =
  /(?:这|这一|当前|本)(?:一)?页|(?:这个|当前)页面|第几页|我(?:正)?在看(?:的)?(?:哪|第几)页|(?:解释|说明|分析|看看)?(?:这里|这段|这一段|这个图|这张图|这幅图|这个公式|当前看到的内容)|this page|current page|currently visible page|visible page|this passage|this figure|this formula|what (?:am i|i am|i'm) (?:looking at|reading|viewing)|what page (?:am i|i am|i'm) (?:on|reading|viewing)/i
const FULL_DOCUMENT_INTENT =
  /全文|全篇|整篇|整份|整(?:个|份)(?:文档|论文|文章)|通读|概述(?:一下)?(?:这|本|该)?(?:篇)?(?:论文|文章|文献)|解读(?:一下)?(?:这|本|该)?(?:篇)?(?:论文|文章|文献)|总结(?:一下)?(?:这|本|该)?篇?(?:论文|文章|文献)|(?:梳理|分析|提炼|系统(?:性)?解读)(?:一下)?(?:这|本|该)?(?:篇|项)?(?:论文|文章|文献|研究)(?:的)?[^。！？\n]{0,36}(?:核心贡献|研究问题|方法|实验|结果|结论|局限)|whole (?:paper|document|article)|entire (?:paper|document|article)|full (?:paper|document|article)|summari[sz]e .*(?:paper|document|article)|(?:overview|interpretation) of (?:this|the) (?:paper|document|article)|read (?:this|the) (?:whole|entire) (?:paper|document|article)|(?:analy[sz]e|synthesi[sz]e|explain|walk me through) (?:this|the) (?:paper|document|article)[^.?!\n]{0,48}(?:contributions?|methods?|experiments?|results?|limitations?|conclusions?)/i

export const resolvePdfPreparationScope = (
  text: string,
  readingPosition: PdfReadingPosition | undefined
): PdfPreparationScope => {
  if (FULL_DOCUMENT_INTENT.test(text)) return 'full-document'
  if (readingPosition && CURRENT_PAGE_INTENT.test(text)) return 'current-page'
  return 'auto'
}
