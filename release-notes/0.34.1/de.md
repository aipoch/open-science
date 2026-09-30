## ✨ Highlights

- **Neues Konnektor-Duo.** Ein CELLxGENE-Discover-Konnektor entdeckt öffentliche Single-Cell-Datensätze, und ein Alliance-of-Genome-Resources-Konnektor deckt artübergreifende Modellorganismus-Gene ab. (#3178, #3136)
- **Varianten- und Omics-Erweiterung.** MaveDB-Funktions-Scores ergänzen den Varianten-Konnektor, und der Omics-Konnektor erweitert seine Metabolomics-Workbench-Abdeckung. (#3131, #3139)
- **Posteingang in der Library-Vorschau.** Die Library-Vorschau des Workspaces erhält einen Posteingang-Tab für die ausstehende Warteschlange mit Annehmen, Verwerfen, Rückgängigmachen und Stapelannahme. (#3174)
- **gpt-6.1-sol.** Die Modellauswahl ergänzt gpt-6.1-sol, ohne bestehende Vorgaben zu ändern. (#3157)

## 🚀 Neue Funktionen

- CELLxGENE-Discover-Konnektor: Öffentliche Single-Cell-Datensätze und -Sammlungen durchsuchen, nach Organismus, Gewebe, Krankheit, Assay oder Zelltyp filtern, veröffentlichte Versionen prüfen sowie Dateiformate, Größen und Download-URLs abrufen, ergänzt um CellGuide-Zelltyp-Beschreibungen und Markergene. (#3178)
- Alliance-of-Genome-Resources-Konnektor: Gene über Mensch, Maus, Ratte, Fliege, Wurm, Zebrafisch, Hefe und Frosch hinweg suchen und zusammenfassen — Orthologe, Krankheitsmodelle, Phänotyp-Annotationen, Allele, Expression und Krankheitsbegriff-Zuordnungen. (#3136)
- MaveDB-Funktions-Scores im Varianten-Konnektor: Score-Set-Suche und Metadaten, assayspezifische Funktions-Scores, VRS-Variantenzuordnungen und Experimente. (#3131)
- Erweiterte Metabolomics-Workbench-Abdeckung im Omics-Konnektor: Studien-Datensätze, Proben, experimentelle Faktoren, Analysemetadaten sowie Verbindungsstrukturen und Querverweise. (#3139)
- gpt-6.1-sol als Modelloption, ohne Änderung der Vorgaben. (#3157)
- Posteingang-Tab in der Library-Vorschau des Workspaces: Die ausstehende Warteschlange mit Suche und Seitenumbruch durchsuchen, einzelne Einträge mit Rückgängigmachen annehmen oder verwerfen und Stapel über explizite Seitenauswahl annehmen. (#3174)
- Ein `.science`-Importeintrag im Leerzustand des Workspaces zum Importieren von Forschungspaketen. (#3170)
- Sitzungspakete können anerkannte sensible Inhalte mit expliziter Bestätigung exportieren. (#3164)
- Lokale Diagnose-Exporte bewahren Fehlerbehebungsnachweise für den Support. (#3143)
- Feedback-Sendekürzel in Sitzungsplänen. (#3125)
- Host-Status im Compute-Menü des Composers angezeigt. (#3124)

## 🔧 Verbesserungen

- Run-Vorschauen verlinken direkt auf die relevanten Nachrichten. (#3120)
- Skill-Entwürfe sind geschützt, und Skill-Interaktionen sind klarer erklärt. (#3142)
- Hinweise zur Journal-Zuordnung sind vereinfacht, und Spaltenrollen beim Journal-Import sind klarer erklärt. (#3172, #3169)

## 🐛 Fehlerbehebungen

- **Notebooks und Laufzeiten** — der Interpreter-Zustand bleibt über Zellen hinweg erhalten (#3129); globale npm-Tools der Sandbox werden über Sitzungen hinweg geteilt (#3160); Loopback-Gateway-Bind-Fehler werden in verständlicher Sprache erklärt (#3138); die Erfassung wissenschaftlicher Python- und R-Herkunftsinformationen ist gehärtet (#3163).
- **PDF und Vorschau** — nativer Abbildungs- und Tabelleninhalt bleibt bei der Strukturextraktion erhalten (#3162); PDF-Vorschau-Worker laufen in Browser-Clients (#3135); Referenz-URLs erscheinen in der Detailansicht (#3151); die Annotationsauswahl wird geschlossen, bevor der Reader sich schließt (#3156); Styling der zusammengeführten Tabellenvorschau und der Schatten der fixierten Spalte sind korrigiert (#3165, #3167).
- **Sitzungen und Pakete** — Follow-up-Berechtigungen überleben Agent-Neustarts (#3147); boolesche Metadaten bleiben beim Paketexport erhalten (#3133).
- **Journals** — Journal-Filter werden validiert, und Alias-Spalten werden erkannt (#3145); ungültig gewordene Journal-Eintragslesezugriffe werden erneut versucht (#3148).
- **Plattform** — Windows erlaubt die Neuinstallation nach Entfernen einer alten übergeordneten Installation (#3176); der Linux-KWallet-Start ist wiederhergestellt (#3168); die Anmeldedaten-Identität akzeptiert abgeschlossene SQLite-Journals (#3126).
