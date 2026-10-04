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
- Netzwerkzugriffsregeln trennen öffentliche Automatisierung von überprüften privaten Diensten: private Erteilungen binden an einen genauen Hostnamen, Port und einen geprüften Adresssatz, wobei der DNS vor dem Speichern erneut geprüft wird. (#3249)
- PDB-Strukturen-Konnektor erhält Proteinfolgen-Suche: experimentelle Strukturen anhand der Aminosäuresequenz finden, mit Filtern für Identität, E-Wert und Coverage. (#3250)
- IEDB-Konnektor: Immunologie-Evidenzwerkzeuge — Epitope, Antigene sowie T-Zell-, B-Zell- und MHC-Assays mit Quellenpublikationen durchsuchen. (#3261)

## 🔧 Verbesserungen

- Die Analyse von Abbildungen und Tabellen in PDFs nutzt jetzt begrenzte Parallelarbeit und beschleunigt große Dokumente. (#3228)
- Abhängigkeiten wurden aktualisiert, um bekannte verwundbare transitive Pakete zu beseitigen. (#3190)
- Die Oberfläche von Workspace und Einstellungen ist kompakter, einschließlich Werkzeugkarten in Nachrichten, Abständen der Seitenleistennavigation und der Netzwerkstatus-Karte. (#3226, #3225, #3214)
- Der Import-Hinweis im Workspace erhält für Barrierefreiheit mehr Kontrast. (#3205)

## 🐛 Fehlerbehebungen

- **Replay und Sitzungen** — der Notebook-Zustand bleibt im Replay erhalten und generierte Galerien sind stabilisiert (#3219); Zug-Ergebnisse und Operationsfehler werden zuverlässig persistiert (#3171); Warten-auf-Nutzer überlebt App-Neustarts (#3223).
- **Notebook und Laufzeiten** — Windows-REPL-Start und -Bereinigung sind gehärtet (#3173); Erteilungen des übergeordneten Systems an ACLs werden aus der Windows-Sandbox blockiert (#3256); die Windows-Laufzeit-Kompatibilitätsbestätigung und ihre Diagnose sind gehärtet (#3255); der Start der Windows-Sandbox verzögert sich nicht mehr durch wiederholte ACL-Neuaufbauten (#3257); im Explorer ausgewählte WSL-Distro-Ordner werden ohne Subprozessstart zugeordnet (#3254); die isolierte Windows-Laufzeitausführung ist repariert (#3105); per pip generierte Entry Points werden erkannt (#3237); wissenschaftliche I/O-Pfade und Loader-Unsicherheiten bleiben erhalten (#3216); kontextbezogene Ordnerzugriffserteilungen werden bei Bedarf angeboten (#3220); übergeordnete Traversierung für verwaltete Pfade wird ohne Verzeichnisaufzählung erteilt (#3246).
- **PDF und Vorschau** — die Gliederungsnavigation stimmt mit Abschnittspositionen überein (#3234); nicht verfügbare Gliederungen werden verständlich dargestellt und schmale Navigation schwebt (#3232); die Notiz-Seitenleiste schwebt in schmalen Readern (#3229); nativer Abbildungs- und Tabelleninhalt bleibt über verschiedene Paper-Layouts erhalten (#3217); die Layout-Extraktion für Literatur ist für komplexe Paper gehärtet (#3247).
- **Agents und Berechtigungen** — erteilte Ordner werden Codex-Sitzungen bereitgestellt (#3209); die ACP-Erteilungsabgleichung ist vereinheitlicht mit Diagnose von Fallback-Genehmigungen (#3189); native OpenCode-Skill-Updates korrelieren korrekt (#3198); die Wiederherstellung von Ordnerberechtigungen wird im Workspace sichtbar gemacht (#3235).
- **Workspace und Pakete** — identische `.science`-Objekte werden dedupliziert (#3206); Provider- und Projekt-Entwürfe sind geschützt und Aktionsfeedback ist klarer (#3182); Hintergrundfehler können verworfen werden (#3203); lange Skill-Beschreibungen werden auf eine Zeile gekürzt, der volle Text erscheint bei Hover (#3253).
