## ✨ Highlights

- **Eigenständiges Node-Backend.** Die gemeinsamen Dienste hinter Desktop, Web, CLI und Notebook laufen nun in einem gewöhnlichen Node-Prozess — Kommandozeile und Headless-Modus benötigen keinen fensterlosen Electron-Host mehr, die Desktop-App verbindet sich als nativer Client, und Desktop-Backends wählen automatisch einen freien Port. (#3358, #3393)
- **Konnektor-Reichweite.** Ein neuer eingebauter ENCORI-Konnektor bringt miRNA-Ziel- und RNA-RNA-Interaktionsnachweise, ChEMBL ergänzt Assay-Details und Bioaktivitäts-Paginierung, und ClinVar fügt Einzelnachweis-Einreichungen hinzu. (#3376, #3343, #3361)
- **Treue für wissenschaftliche PDFs.** Die PDF-Übersetzung bewahrt die native Lesereihenfolge, verschachtelte ActualText-Labels werden korrekt verifiziert, und die Strukturextraktion erhält quelleigene Abbildungen und vollständige Tabellendatensätze. (#3360, #3348, #3370)
- **Ruhigere Notebook-Genehmigungen und -Erfassung.** Bereite Standard-Laufzeitumgebungen fragen nicht mehr doppelt nach, gemischte Umgebungen werden genau gemeldet, und Build-Metadaten von Paketen bleiben sichtbar. (#3380, #3398, #3385)

## 🚀 Neue Funktionen

- Eigenständiges Node-Backend für gemeinsame Dienste — `open-science start` läuft ohne Electron, und die Desktop-App verbindet sich als nativer Client (#3358)
- ENCORI-Konnektor mit zehn Werkzeugen für miRNA-Ziele, RNA-RNA-Interaktionen, regulatorische Nachweise, Referenztabellen und Bulk-Datensätze (#3376)
- ChEMBL-Konnektor erhält Assay-Details und Bioaktivitäts-Paginierung über die ersten 1.000 Datensätze hinaus (#3343)
- ClinVar-Konnektor erhält Einzelnachweis-Einreichungen zum Vergleich der Klassifizierungen von Einreichern (#3361)
- Leerer Startzustand der Startseite mit Anleitung und einer Aktion zum Erstellen eines Projekts (#3371)

## 🔧 Verbesserungen

- Notebook-Umgebungen: präzise gemischte Conda/pip-Erfassung, bewahrte micromamba-Build-Metadaten in der Pakettabelle sowie gehärtete Callback-Abhängigkeiten und Dateieingabe-Herkunft (#3398, #3385, #3369)
- Linux-Anmeldedaten prüfen nach dem ersten Geheimnis-Vorgang nicht mehr den Secret-Service-Backend, wodurch fälschliche, fatale Wiederherstellungsabbrüche verhindert werden (#3389)
- Die Genehmigung und das Verwerfen von Sitzungsplänen stören die Ausführungswiederherstellung nicht mehr (#3366)

## 🐛 Fehlerbehebungen

- Desktop-Backends belegen einen freien Port und beheben damit Startfehler, wenn bereits ein anderes Backend läuft (#3393)
- Die Python-Erkennung unter Windows interpretiert Interpreterpfade mit Leerzeichen oder Klammern nicht mehr falsch (#3362)
- Die Desktop-Laufzeitumgebung bewahrt das ausgewählte Backend-Profil unter Windows (#3395)
- Der Import eines `.science`-Pakets in ein neues Projekt schlägt bei der Katalog-Übernahme nicht mehr fehl (#3379)
- Intelligente Sammlungen setzen den fehlgeschlagenen Stapel fort und versuchen ihn erneut, statt von vorne zu beginnen (#3351)
- Codex stellt gestreamte MCP-Werkzeugargumente wieder her, die im abgeschlossenen Aufruf leer ankommen (#3349)
- Das Wechseln von Specialists unter Windows hinterlässt keine genehmigte Übergabe mehr, die ausstehend bleibt und spätere Abfragen blockiert (#3388)
