const fs = require('fs')
const zhHans = JSON.parse(fs.readFileSync('src/renderer/src/locales/zh-Hans.json', 'utf8'))
const zhHant = JSON.parse(fs.readFileSync('src/renderer/src/locales/zh-Hant.json', 'utf8'))

// These are truly orphaned - verified not used in source
const orphanedKeys = [
  'ran {{count}} tools_other',
  'read {{count}} files_other',
  'saved {{count}} files_other',
  '{{count}} failed_other',
  '{{count}}s'
]

console.log('Deleting remaining orphaned keys:')
orphanedKeys.forEach((key) => {
  if (key in zhHans) {
    delete zhHans[key]
    delete zhHant[key]
    console.log('  ✓', key)
  }
})

fs.writeFileSync('src/renderer/src/locales/zh-Hans.json', JSON.stringify(zhHans, null, 2) + '\n')
fs.writeFileSync('src/renderer/src/locales/zh-Hant.json', JSON.stringify(zhHant, null, 2) + '\n')

console.log('\nCatalogs updated - all orphans removed')
