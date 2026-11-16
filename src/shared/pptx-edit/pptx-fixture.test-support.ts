import { strToU8, unzipSync, zipSync } from 'fflate'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NSS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"`

export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const rels = (...items: [string, string, string][]): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`
    )
    .join('')}</Relationships>`

const tree = (shapes: string): string =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`

const xfrm = (x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`

const textShape = (id: number, name: string, text: string, frame = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${frame}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="3200"><a:solidFill><a:srgbClr val="222222"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="2000" cy="1000"/></a:xfrm></p:grpSpPr>${textShape(4, 'Child', 'Grouped text', xfrm(0, 0, 1000, 500))}</p:grpSp>`

const cell = (text: string, extra = ''): string =>
  `<a:tc${extra}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`

const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="500000" y="2500000"/><a:ext cx="4000000" cy="800000"/></p:xfrm><a:graphic><a:graphicData uri="${A}/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="400000">${cell('A1')}${cell('B1')}</a:tr><a:tr h="400000">${cell('A2')}${cell('B2')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`

const picture = `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(1000, 1000, 3000, 2000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const chartFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="500000" y="500000"/><a:ext cx="5000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>`

const cache = (values: string[]): string =>
  `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:strCache>`

const axisTitle = (text: string): string =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`

const chartXml = `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart>${axisTitle('Revenue')}<c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>${cache(['2025'])}</c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f>${cache(['Q1', 'Q2'])}</c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart><c:catAx><c:axId val="1"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`

const notesXml = (text: string): string =>
  `<p:notes ${NSS}>${tree(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`)}</p:notes>`

const layoutXml = `<p:sldLayout ${NSS} type="obj"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`

const override = (part: string, type: string): string =>
  `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`

const fixtureFiles = (): Record<string, string | Uint8Array> => {
  const layoutRel = rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'])
  const withLayout = (...extra: [string, string, string][]): string =>
    rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...extra)
  const slide = (shapes: string): string => `<p:sld ${NSS}>${tree(shapes)}</p:sld>`
  return {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${[
      override('ppt/presentation.xml', 'presentationml.presentation.main'),
      override('ppt/slides/slide1.xml', 'presentationml.slide'),
      override('ppt/slides/slide2.xml', 'presentationml.slide'),
      override('ppt/slides/slide3.xml', 'presentationml.slide'),
      override('ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout'),
      override('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster'),
      override('ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster'),
      override('ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide'),
      override('ppt/charts/chart1.xml', 'drawingml.chart')
    ].join('')}</Types>`,
    '_rels/.rels': rels(['rId1', 'officeDocument', 'ppt/presentation.xml']),
    'docProps/app.xml':
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Slides>3</Slides></Properties>',
    'ppt/presentation.xml': `<p:presentation ${NSS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(
      ['rId1', 'slide', 'slides/slide1.xml'],
      ['rId2', 'slide', 'slides/slide2.xml'],
      ['rId3', 'slide', 'slides/slide3.xml'],
      ['rId10', 'notesMaster', 'notesMasters/notesMaster1.xml'],
      ['rId11', 'slideMaster', 'slideMasters/slideMaster1.xml']
    ),
    'ppt/slides/slide1.xml': slide(
      `${textShape(2, 'Title', 'Hello', xfrm(457200, 457200, 8229600, 1371600))}${group}${table}`
    ),
    'ppt/slides/_rels/slide1.xml.rels': withLayout([
      'rId2',
      'notesSlide',
      '../notesSlides/notesSlide1.xml'
    ]),
    'ppt/slides/slide2.xml': slide(`${picture}${textShape(3, 'Inherited', 'No frame')}`),
    'ppt/slides/_rels/slide2.xml.rels': withLayout(['rId2', 'image', '../media/image1.png']),
    'ppt/media/image1.png': Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0)),
    'ppt/slides/slide3.xml': slide(chartFrame),
    'ppt/slides/_rels/slide3.xml.rels': withLayout(['rId2', 'chart', '../charts/chart1.xml']),
    'ppt/charts/chart1.xml': chartXml,
    'ppt/notesSlides/notesSlide1.xml': notesXml('First notes'),
    'ppt/notesSlides/_rels/notesSlide1.xml.rels': rels(
      ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
      ['rId2', 'slide', '../slides/slide1.xml']
    ),
    'ppt/notesMasters/notesMaster1.xml': `<p:notesMaster ${NSS}>${tree('')}</p:notesMaster>`,
    'ppt/slideLayouts/slideLayout1.xml': layoutXml,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
      'rId1',
      'slideMaster',
      '../slideMasters/slideMaster1.xml'
    ]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${NSS}>${tree('')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': layoutRel
  }
}

export const createDeckFixture = (): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(fixtureFiles()).map(([name, value]) => [
        name,
        typeof value === 'string' ? strToU8(value) : value
      ])
    )
  )

export const unzipEntries = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes)
