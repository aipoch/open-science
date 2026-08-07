// Pins the interface language to English for every test.
//
// Deliberately explicit rather than letting the renderer's detection run: jsdom reports 'en-US' by
// default, which would resolve to English anyway, but a CI runner or developer machine with a Chinese
// system language would flip every render assertion in the suite. Pinning here keeps the existing
// English expectations meaningful and makes a locale-dependent test opt in by switching the language
// itself.

import { initI18n } from '../src/renderer/src/i18n'

initI18n('en')
