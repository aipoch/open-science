// Only explicit, recognized quantities are checked. This is not dimensional analysis:
// do not infer units from table headers, convert values, or interpret arbitrary nouns.
const units: Array<[string, string]> = [
  [
    'percentage-point',
    'percentage[ -]points?|percent[ -]points?|(?:个|個)?百分点|(?:个|個)?百分點|パーセントポイント|퍼센트\\s*포인트|Prozentpunkte?n?|points? de pourcentage|puntos? porcentuales|punt[oi] percentuali|pontos? percentuais|procentpunt(?:en)?|نقاط مئوية|نقطة مئوية|प्रतिशत अंक|процентн(?:ый|ых|ого) пункт(?:а|ов)?'
  ],
  [
    'percent',
    '%|percent(?:age)?|per cent|百分比|パーセント|퍼센트|Prozent|pour cent|por ciento|per cento|por cento|procent|بالمئة|بالمائة|في المئة|في المائة|प्रतिशत|процент(?:а|ов)?'
  ],
  ['permille', '‰|per mille|por mil|promille|في الألف|千分比'],
  [
    'mg',
    'mg|milligrams?|毫克|ミリグラム|밀리그램|Milligramm(?:e|en)?|milligrammes?|miligramos?|milligramm[oi]|miligramas?|milligrammen|مليغرام(?:ات)?|ملليغرام(?:ات)?|मिलीग्राम|मिलिग्राम|миллиграмм(?:а|ов)?'
  ],
  [
    'ug',
    '[μµu]g|micrograms?|微克|マイクログラム|마이크로그램|Mikrogramm(?:e|en)?|microgrammes?|microgramos?|microgramm[oi]|microgramas?|microgrammen|ميكروغرام(?:ات)?|माइक्रोग्राम|микрограмм(?:а|ов)?'
  ],
  [
    'kg',
    'kg|kilograms?|千克|公斤|キログラム|킬로그램|Kilogramm(?:e|en)?|kilogrammes?|kilogramos?|chilogramm[oi]|quilogramas?|kilogrammen|كيلوغرام(?:ات)?|किलोग्राम|килограмм(?:а|ов)?'
  ],
  [
    'g',
    'g|grams?|克|グラム|그램|Gramm(?:e|en)?|grammes?|gramos?|gramm[oi]|gramas?|grammen|غرام(?:ات)?|ग्राम|грамм(?:а|ов)?'
  ],
  [
    'ml',
    'mL|ml|millilit(?:er|re)s?|毫升|ミリリットル|밀리리터|Milliliter[n]?|millilitres?|mililitros?|millilitr[oi]|milliliter|مليلتر(?:ات)?|ملليلتر(?:ات)?|मिलीलीटर|मिलिलीटर|миллилитр(?:а|ов)?'
  ],
  [
    'l',
    'L|l|lit(?:er|re)s?|升|リットル|리터|Liter[n]?|litres?|litros?|litr[oi]|لتر(?:ات)?|लीटर|литр(?:а|ов)?'
  ],
  [
    'mm',
    'mm|millimet(?:er|re)s?|毫米|ミリメートル|밀리미터|Millimeter[n]?|millimètres?|milímetros?|millimetr[oi]|مليمتر(?:ات)?|ملليمتر(?:ات)?|मिलीमीटर|मिलिमीटर|миллиметр(?:а|ов)?'
  ],
  [
    'cm',
    'cm|centimet(?:er|re)s?|厘米|センチメートル|센티미터|Zentimeter[n]?|centimètres?|centímetros?|centimetr[oi]|سنتيمتر(?:ات)?|सेंटीमीटर|сантиметр(?:а|ов)?'
  ],
  [
    'nm',
    'nm|nanomet(?:er|re)s?|纳米|奈米|ナノメートル|나노미터|Nanometer[n]?|nanomètres?|nanómetros?|nanômetros?|nanometr[oi]|نانومتر(?:ات)?|नैनोमीटर|нанометр(?:а|ов)?'
  ],
  [
    'm',
    'm|met(?:er|re)s?|米|メートル|미터|Meter[n]?|mètres?|metros?|metr[oi]|متر(?:ات)?|मीटर|метр(?:а|ов)?'
  ],
  [
    'celsius',
    '°\\s*C|degrees? Celsius|摄氏度|攝氏度|摂氏|섭씨|Grad Celsius|degrés? Celsius|grados? Celsius|grad[oi] Celsius|graus? Celsius|graden Celsius|graad Celsius|درجة مئوية|درجات مئوية|डिग्री सेल्सियस|градус(?:а|ов)? Цельсия'
  ],
  [
    'fahrenheit',
    '°\\s*F|degrees? Fahrenheit|华氏度|華氏度|華氏|화씨|Grad Fahrenheit|degrés? Fahrenheit|grados? Fahrenheit|grad[oi] Fahrenheit|graus? Fahrenheit|graden Fahrenheit|graad Fahrenheit|درجة فهرنهايت|درجات فهرنهايت|डिग्री फ़ारेनहाइट|डिग्री फारेनहाइट|градус(?:а|ов)? Фаренгейта'
  ]
]
const number = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?:e[+−-]?\d+)?`
// Word boundaries prevent abbreviations or singular aliases matching ordinary prose.
const alternatives = units.map(([, aliases]) => `(?:${aliases})`).join('|')
const unit = `(?:${alternatives})(?:(?![\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Arabic}\\p{Script=Devanagari}])|(?<=[%‰]))(?:\\^?[23])?`
const quantity = new RegExp(
  `(?<![\\p{Script=Latin}\\p{N}.]|\\d,)(${number})\\s*(${unit}(?:\\s*(?:/|per|por|प्रति|لكل|每)\\s*${unit})*)`,
  'giu'
)
const unitPatterns = units.map(
  ([name, aliases]) => [name, new RegExp(`^(?:${aliases})$`, 'iu')] as const
)

const normalize = (text: string): string =>
  text
    // Read scientific powers before NFKC flattens superscripts. The owner may
    // already have converted the same power to ^ notation in the translation.
    .replace(
      /(\d+(?:[.,]\d+)?)\s*[×·]\s*10(?:\^\(?([+−-]?\d{1,2})\)?|([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}))(?!\d)/gu,
      (_, coefficient: string, exponent: string, raised: string) =>
        coefficient +
        'e' +
        (exponent ??
          [...raised].map((digit) => (digit === '⁻' ? '-' : '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(digit))).join(''))
    )
    .replaceAll('，', ' ')
    .replace(/\d{1,3}(?:[\u00a0\u202f]\d{3})+/gu, (value) => value.replace(/[\u00a0\u202f]/gu, ''))
    .normalize('NFKC')
    .replace(new RegExp(`每\\s*(${unit})\\s*(${number})\\s*(${unit})`, 'giu'), '$2 $3/$1')
    .replace(
      new RegExp(
        `(${unit})\\s+(?:[·⋅*]\\s*)?(${unit})\\s*(?:\\^\\(?[-−]1\\)?|[-−]1)(?!\\d)`,
        'giu'
      ),
      '$1/$2'
    )
    .replace(/摄氏\s*([+−-]?\d+(?:[.,]\d+)?)\s*度/gu, '$1摄氏度')
    .replace(/攝氏\s*([+−-]?\d+(?:[.,]\d+)?)\s*度/gu, '$1攝氏度')
    .replace(/(?:摂氏|섭씨)\s*([+−-]?\d+(?:[.,]\d+)?)\s*(?:度|도)/gu, '$1°C')
    .replace(/(?:华氏|華氏|화씨)\s*([+−-]?\d+(?:[.,]\d+)?)\s*(?:度|도)/gu, '$1°F')
    .replace(/百分之\s*([+−-]?\d+(?:[.,]\d+)?)/gu, '$1%')
    .replace(/千分之\s*([+−-]?\d+(?:[.,]\d+)?)/gu, '$1‰')
const canonicalValue = (value: string): string => {
  value = value.replaceAll('−', '-')
  if (value.includes(',') && value.includes('.')) {
    const decimal = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.'
    return String(Number(value.replaceAll(decimal === ',' ? '.' : ',', '').replace(',', '.')))
  }
  if (/^[1-9]\d{0,2}(?:,\d{3})+$|^[1-9]\d{0,2}(?:\.\d{3}){2,}$/u.test(value))
    return String(Number(value.replace(/[.,]/gu, '')))
  return String(Number(value.replace(',', '.')))
}
const canonicalUnit = (value: string): string =>
  value
    // Percentage words contain "per", "por" or "प्रति" without denoting a ratio.
    .split(/\s*(?:\/|\b(?:per|por)\b(?!\s+(?:cent(?:o)?|ciento)\b)|प्रति(?!शत)|لكل|每)\s*/iu)
    .map((part) => {
      const power = part.match(/\^?([23])$/u)?.[1] ?? ''
      const base = part.replace(/\^?[23]$/u, '').trim()
      return (unitPatterns.find(([, pattern]) => pattern.test(base))?.[0] ?? base) + power
    })
    .join('/')

type Quantity = { value: string; unit: string }
function quantities(input: string): Quantity[] {
  const text = normalize(input)
  const result: Quantity[] = []
  for (const match of text.matchAll(quantity)) {
    const boundUnit = canonicalUnit(match[2])
    result.push({ value: canonicalValue(match[1]), unit: boundUnit })
    // Shared units in an explicit range/list apply to each endpoint (5–10 mg,
    // 82 and 91%, 5 ± 2 mg). Never jump over ordinary prose to borrow a unit.
    let prefix = text.slice(0, match.index)
    const preceding = new RegExp(
      `(?<![\\p{Script=Latin}\\p{N}.]|\\d,)(${number})\\s*(?:[-–—±,、]|(?<![\\p{L}])(?:to|and|bis|und|et|à|a|y|e|até|en|tot|до|и)(?![\\p{L}])|और|से|و|إلى|(?:上升|提高|提升|增加|下降|降低|减少|減少)?[至到]|和|から|と|에서|및)\\s*$`,
      'iu'
    )
    for (let previous = preceding.exec(prefix); previous; previous = preceding.exec(prefix)) {
      result.push({ value: canonicalValue(previous[1]), unit: boundUnit })
      prefix = prefix.slice(0, previous.index)
    }
  }
  return result
}

// Match occurrences of (value, unit), not independent bags of numbers and units.
// Repeated values in different units must each be accounted for. Legitimate word
// order changes are allowed; arbitrary unknown unit names remain outside this guard.
export function pdfTranslationMissingNumericUnits(source: string, translation: string): string[] {
  const available = new Map<string, number>()
  for (const { value, unit } of quantities(translation)) {
    const key = `${value} ${unit}`
    available.set(key, (available.get(key) ?? 0) + 1)
  }
  return quantities(source).flatMap(({ value, unit }) => {
    const key = `${value} ${unit}`
    const count = available.get(key) ?? 0
    if (!count) return [key]
    available.set(key, count - 1)
    return []
  })
}
