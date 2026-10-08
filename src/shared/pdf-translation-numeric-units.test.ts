import { describe, expect, it } from 'vitest'
import { pdfTranslationMissingNumericUnits as missing } from './pdf-translation-numeric-units'

describe('numeric unit bindings', () => {
  it.each([
    [
      'Italian',
      [
        'milligrammi',
        'microgrammi',
        'chilogrammi',
        'grammi',
        'millilitri',
        'litri',
        'millimetri',
        'centimetri',
        'nanometri',
        'metri',
        'per cento',
        'punti percentuali',
        'gradi Celsius',
        'gradi Fahrenheit'
      ]
    ],
    [
      'Portuguese',
      [
        'miligramas',
        'microgramas',
        'quilogramas',
        'gramas',
        'mililitros',
        'litros',
        'milímetros',
        'centímetros',
        'nanômetros',
        'metros',
        'por cento',
        'pontos percentuais',
        'graus Celsius',
        'graus Fahrenheit'
      ]
    ],
    [
      'Dutch',
      [
        'milligrammen',
        'microgrammen',
        'kilogrammen',
        'grammen',
        'milliliter',
        'liter',
        'millimeter',
        'centimeter',
        'nanometer',
        'meter',
        'procent',
        'procentpunten',
        'graden Celsius',
        'graden Fahrenheit'
      ]
    ],
    [
      'Arabic',
      [
        'مليغرامات',
        'ميكروغرامات',
        'كيلوغرامات',
        'غرامات',
        'مليلترات',
        'لترات',
        'مليمترات',
        'سنتيمترات',
        'نانومترات',
        'مترات',
        'في المئة',
        'نقاط مئوية',
        'درجات مئوية',
        'درجات فهرنهايت'
      ]
    ],
    [
      'Hindi',
      [
        'मिलीग्राम',
        'माइक्रोग्राम',
        'किलोग्राम',
        'ग्राम',
        'मिलीलीटर',
        'लीटर',
        'मिलीमीटर',
        'सेंटीमीटर',
        'नैनोमीटर',
        'मीटर',
        'प्रतिशत',
        'प्रतिशत अंक',
        'डिग्री सेल्सियस',
        'डिग्री फ़ारेनहाइट'
      ]
    ]
  ])('checks equivalent and mismatched %s unit words', (_language, aliases) => {
    const symbols = [
      'mg',
      'μg',
      'kg',
      'g',
      'mL',
      'L',
      'mm',
      'cm',
      'nm',
      'm',
      '%',
      'percentage points',
      '°C',
      '°F'
    ]
    aliases.forEach((alias, index) => {
      expect(missing(`5 ${symbols[index]}`, `5 ${alias}`)).toEqual([])
      expect(missing(`5 ${symbols[index]}`, `6 ${alias}`)).not.toEqual([])
      expect(missing(`5 ${symbols[(index + 1) % symbols.length]}`, `5 ${alias}`)).not.toEqual([])
    })
  })

  it.each([
    ['5 grams', '5 grammi'],
    ['5 grams', '5 gramas'],
    ['82 percent', '82 por cento'],
    ['5 mg and 10 mg', '5 e 10 milligrammi'],
    ['5 mg and 10 mg', '5 e 10 miligramas'],
    ['5–10 mg', '5 até 10 miligramas'],
    ['5 mg and 10 mg', '5 en 10 milligrammen'],
    ['5–10 mg', '5 tot 10 milligrammen'],
    ['5 mg/L', '5 milligrammi per litro'],
    ['5 mg/L', '5 miligramas por litro'],
    ['5 mg/L', '5 मिलीग्राम प्रति लीटर'],
    ['5 mg/L', '5 مليغرام لكل لتر'],
    ['5 mg and 10 mg', '5 और 10 मिलीग्राम'],
    ['5 mg and 10 mg', '5 و 10 مليغرام'],
    ['5 grams', '5 grammo'],
    ['5 grams', '5 grama'],
    ['5 mm²', '5 millimetri²'],
    ['5 mg/kg', '5 miligramas/quilogramas'],
    ['5 mg/mL', '5 milligrammi/millilitri']
  ])('accepts localized unit bindings: %s → %s', (source, translation) => {
    expect(missing(source, translation)).toEqual([])
  })

  it.each([
    ['5 grams', '5 graminacee'],
    ['5 grams', '5 gramática'],
    ['5 grams', '5 grammenboek'],
    ['5 grams', '5 غرامة'],
    ['5 grams', '5 ग्रामीण'],
    ['5 mg/kg', '5 miligramas/litro'],
    ['5 mg and 10 mg', '5 persone e 10 milligrammi'],
    ['9 percentage points', '9 por cento']
  ])('does not weaken localized unit checks: %s → %s', (source, translation) => {
    expect(missing(source, translation)).not.toEqual([])
  })

  it.each([
    ['Accuracy increased from 82 percent to 91 percent.', '准确率从82个百分点提升至91个百分点。'],
    ['Accuracy increased from 82 percent to 91 percent.', '准确率从82提升至91。'],
    ['The improvement was 9 percentage points.', '改善了9%。'],
    ['The dose was 5 mg in 10 mL.', '剂量为5毫升，体积为10毫克。'],
    ['The dose was 5 mg in 5 mL.', '剂量为5毫克，体积为5。'],
    ['Concentration was 5 mg/mL.', '浓度为5毫克。'],
    ['Dose was 5 mg/kg.', '剂量为5毫克/升。'],
    ['Area was 5 mm².', '面积为5毫米。'],
    ['Temperature was 25 degrees Celsius.', '温度为25华氏度。'],
    ['Use 5–10 mg.', '使用5至10。'],
    ['The rate was 5‰.', '比率为5%。'],
    ['95%CI was reported.', '报告了95CI。']
  ])('rejects changed or detached units: %s', (source, translation) => {
    expect(missing(source, translation).length).toBeGreaterThan(0)
  })

  it.each([
    ['Accuracy increased from 82 percent to 91 percent.', '准确率从82%提高至91%。'],
    ['Accuracy increased from 82 percent to 91 percent.', '准确率从百分之82提高至百分之91。'],
    ['Accuracy increased from 82 percent to 91 percent.', '准确率为82和91％。'],
    ['Accuracy increased from 82 percent to 91 percent.', '准确率从82提升至91％。'],
    [
      'Concentration increased from 2.5 to 4.0 milligrams per liter.',
      '浓度从2.5上升到4.0毫克每升。'
    ],
    ['The improvement was 9 percentage points.', '改善了9个百分点。'],
    ['The dose was 5 mg in 10 mL.', '在10毫升中加入5毫克。'],
    ['Concentration was 5 milligrams per liter.', '浓度为5毫克/升。'],
    ['Concentration was 5 mg/L.', '浓度为每升5毫克。'],
    ['Concentration was 5 mg/L.', '浓度为5毫克每升。'],
    ['Concentration was 5 mg L⁻¹.', '浓度为5毫克/升。'],
    ['Dose was 1,000 mg.', '剂量为1000毫克。'],
    ['Dose was 0.005 mg.', '剂量为0,005毫克。'],
    ['Dose was 1,234.5 mg.', '剂量为1.234,5毫克。'],
    ['Dose was 5 × 10³ mg.', '剂量为5 × 10^3毫克。'],
    ['Dose was 5 × 10³ mg.', '剂量为5000毫克。'],
    ['Dose was 5 × 10⁻³ mg.', '剂量为5 × 10^(-3)毫克。'],
    ['Dose was 5e-3 mg.', '剂量为0.005毫克。'],
    ['Dose was 1\u202f000 mg.', '剂量为1000毫克。'],
    ['Use 5 mg,10 mL.', '使用5毫克、10毫升。'],
    ['Use 5–10 mg.', '使用5毫克至10毫克。'],
    ['Use 5 mg and 10 mg.', '使用5和10毫克。'],
    ['Use 5 ± 2 mg.', '使用5±2毫克。'],
    ['Area was 5 mm².', '面积为5 mm^2。'],
    ['Temperature was 25 degrees Celsius.', '温度为摄氏25度。'],
    ['Temperature was 25 °C.', '温度为25℃。'],
    ['Temperature was -25 °C.', '温度为摄氏-25度。'],
    ['Temperature was 25 °C.', '温度は摂氏25度です。'],
    ['Temperature was 25 °C.', '온도는 섭씨25도이다.'],
    ['Use 2.5 μg.', '使用2,5微克。'],
    ['The rate was 5‰.', '比率为千分之5。'],
    ['Accuracy was 82 percent.', 'Die Genauigkeit betrug 82 Prozent.'],
    ['Accuracy was 82 percent.', 'La précision était de 82 pour cent.'],
    ['Accuracy was 82 percent.', 'La precisión fue del 82 por ciento.'],
    ['Accuracy was 82 percent.', '精度は82パーセントでした。'],
    ['Accuracy was 82 percent.', '정확도는 82퍼센트였다.'],
    ['Accuracy was 82 percent.', 'Точность составила 82 процента.'],
    ['Use 5 models and 10 groups.', '使用5个模型和10个组。'],
    ['See Eq. (5) and Table 10.', '参见式（5）和表10。']
  ])('accepts equivalent units and ordinary counts: %s', (source, translation) => {
    expect(missing(source, translation)).toEqual([])
  })

  it('does not let another occurrence of the same unit satisfy a different value', () => {
    expect(missing('5 mg and 10 mg.', '5和10毫克。')).toEqual([])
    expect(missing('5 mg and 10 mg.', '5是剂量，另外还有10毫克。')).toEqual(['5 mg'])
  })
})
