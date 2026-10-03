## ✨ Highlights

- **Session-Replay.** Aufgezeichnete Sitzungen Schritt für Schritt durchlaufen und die aufgezeichneten Schritte mit Ihrem Agent besprechen. (#3140)
- **Konnektor-Erweiterung.** Neue Cellosaurus- und Monarch-Konnektoren sind dabei, und die GEO-Matrix-Entdeckung ergänzt den Omics-Konnektor. (#3230, #3227, #3238)
- **Strukturextraktion für hochgeladene PDFs.** Die Strukturextraktion funktioniert jetzt auch für hochgeladene PDFs, nicht nur für generierte. (#3222)
- **Native Windows-Titelleistenmenüs.** Die Windows-App erhält richtige Anwendungsmenüs in der Titelleiste. (#3201)

## 🚀 Neue Funktionen

- Session-Replay: aufgezeichnete Sitzungen mit Vorschauen und Wiedergabe-Interaktionen durchlaufen, den Replay-Verlauf durchsuchen und aufgezeichnete Schritte mit Ihrem Agent besprechen. (#3140, #3215, #3218)
- Cellosaurus-Konnektor: Werkzeuge zu Identität und Qualität von Zelllinien — Zelllinien, ihre Identitäten und Qualitätsannotationen nachschlagen. (#3230)
- Monarch-Konnektor: Evidenz zu Phänotyp-Assoziationen über Modellorganismen hinweg — Gen-/Varianten-zu-Phänotyp-Assoziationen mit Belege. (#3227)
- GEO-Matrix-Entdeckung und Preflight-Werkzeuge im Omics-Konnektor: GEO-Expressionsmatrizen finden und Downloads vorbereiten. (#3238)
- Erweiterter OpenCode-Zen-Modellkatalog mit Jev-Klassifikation. (#3239)
- Kontinuierliche Inspektion der Nutzungsdiagramme in den Einstellungen: Nutzung über die Zeit zoomen und prüfen. (#3236)
- Dateien per Drag-and-drop überall in der Unterhaltung anhängen. (#3224)
- Strukturextraktion für hochgeladene PDFs ergänzt die bestehende Unterstützung für generierte PDFs. (#3222)
- Windows-Titelleisten-Anwendungsmenüs für natives Fenstermanagement. (#3201)

## 🔧 Verbesserungen

- Die Analyse von Abbildungen und Tabellen in PDFs nutzt jetzt begrenzte Parallelarbeit und beschleunigt große Dokumente. (#3228)
- Abhängigkeiten wurden aktualisiert, um bekannte verwundbare transitive Pakete zu beseitigen. (#3190)
- Die Oberfläche von Workspace und Einstellungen ist kompakter, einschließlich Werkzeugkarten in Nachrichten, Abständen der Seitenleistennavigation und der Netzwerkstatus-Karte. (#3226, #3225, #3214)
- Der Import-Hinweis im Workspace erhält für Barrierefreiheit mehr Kontrast. (#3205)

## 🐛 Fehlerbehebungen

- **Replay und Sitzungen** — der Notebook-Zustand bleibt im Replay erhalten und generierte Galerien sind stabilisiert (#3219); Zug-Ergebnisse und Operationsfehler werden zuverlässig persistiert (#3171); Warten-auf-Nutzer überlebt App-Neustarts (#3223).
- **Notebook und Laufzeiten** — Windows-REPL-Start und -Bereinigung sind gehärtet (#3173); die isolierte Windows-Laufzeitausführung ist repariert (#3105); per pip generierte Entry Points werden erkannt (#3237); wissenschaftliche I/O-Pfade und Loader-Unsicherheiten bleiben erhalten (#3216); kontextbezogene Ordnerzugriffserteilungen werden bei Bedarf angeboten (#3220).
- **PDF und Vorschau** — die Gliederungsnavigation stimmt mit Abschnittspositionen überein (#3234); nicht verfügbare Gliederungen werden verständlich dargestellt und schmale Navigation schwebt (#3232); die Notiz-Seitenleiste schwebt in schmalen Readern (#3229); nativer Abbildungs- und Tabelleninhalt bleibt über verschiedene Paper-Layouts erhalten (#3217).
- **Agents und Berechtigungen** — erteilte Ordner werden Codex-Sitzungen bereitgestellt (#3209); die ACP-Erteilungsabgleichung ist vereinheitlicht mit Diagnose von Fallback-Genehmigungen (#3189); native OpenCode-Skill-Updates korrelieren korrekt (#3198); die Wiederherstellung von Ordnerberechtigungen wird im Workspace sichtbar gemacht (#3235).
- **Workspace und Pakete** — identische `.science`-Objekte werden dedupliziert (#3206); Provider- und Projekt-Entwürfe sind geschützt und Aktionsfeedback ist klarer (#3182); Hintergrundfehler können verworfen werden (#3203).
