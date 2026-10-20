## ✨ Highlights

- **Überprüfbare Notebook-Ausführung.** Jeder Notebook-Lauf wird vor der Ausführung auf destruktiven oder riskanten Code geprüft; riskante Läufe zeigen eine fokussierte Überprüfungskarte mit Kontext auf Quellcodezeilen und einem dauerhaften Beleg, während gewöhnliche Analysen ohne wiederholte Rückfragen laufen. (#3336)
- **Wiederaufbare geteilte PDF-Übersetzung.** Übersetzen Sie ein vollständiges PDF mit Prüfpunkten auf Absatzebene, wechseln Sie zwischen den Lesemodi Original, Übersetzung und Seite-an-Seite-Vergleich und setzen Sie die Arbeit über Sitzungen hinweg fort — eine gespeicherte Edition pro verwaltetem PDF, geteilt über alle Einträge. (#3334)
- **Konnektor-Erweiterung.** Ein neuer PDC-Konnektor bringt die Entdeckung von Krebs-Proteomik-Studien, Biospecimen und Dateien, und der Genomes-Konnektor erhält populationspezifische Kopplungsungleichgewichts-Abfragen. (#3335, #3337)
- **Claude Haiku 5.5.** Der gebündelte Anthropic-Katalog fügt Claude Haiku 5.5 mit seinem 1M-Token-Kontextfenster hinzu. (#3333)

## 🚀 Neue Funktionen

- Überprüfbare Notebook-Ausführung mit Risikoanalyse pro Lauf und dauerhaften Überprüfungsbelegen (#3336)
- Wiederaufbare PDF-Gesamtdokumentübersetzung mit Lese-Modi Original/Übersetzung/Vergleich (#3334)
- PDC-Konnektor: Krebs-Proteomik-Studien, Biospecimen-Zuordnungen und quantitative Dateimetadaten durchsuchen (#3335)
- Populationspezifische Ensembl-Abfragen zum Kopplungsungleichgewicht: paarweises r²/D′ und Proxy-Varianten-Lookups (#3337)
- Claude Haiku 5.5 im Anthropic-Modellkatalog (#3333)
- „Alle auswählen“ für die geladene Seite in den Stapel-Werkzeugleisten der Literaturbibliothek und des Posteingangs (#3340)
- Ziehen Sie eine Projektdatei-Karte oder das geöffnete Artefakt in den Composer, um es zu erwähnen (#3315)

## 🔧 Verbesserungen

- Die wissenschaftliche Abhängigkeitsherkunft ist für Python- und R-Notebooks belastbarer: mehr wissenschaftliche Reader, Container-Transformationen und Callbacks werden nachverfolgt, sodass Abhängigkeitskanten und Dateieffekte präzise bleiben (#3309, #3332)

## 🐛 Fehlerbehebungen

- Die PDF-Strukturextraktion bewahrt native wissenschaftliche Layouts — vollständige Tabellen, gestufte Kopfzeilen, Fußzeilen und mehrteilige Abbildungen (#3320)
- Das Dateien-Panel blockiert Dateierwähnungen in einer neuen Unterhaltung nicht mehr (#3338)
- Suchen (Strg/Cmd+F) funktioniert wieder in einem leeren Workspace (#3316)
- Der Specialist-Marktplatz öffnet sich in Remote Web (#3331)
- Kompakte Erwähnungs-Chips in Composer neuer Sitzungen werden wieder in normaler Größe dargestellt (#3341)
- Kontextgrößen-Suffix-Aliase sind aus den offiziellen Modellkatalogen entfernt und beheben Modellauswahl-Fehlschläge bei einigen Engines (#3326)
