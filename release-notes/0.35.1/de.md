## ✨ Highlights

- **Konnektor-Erweiterung.** Die GWAS-Summary-Statistics-Discovery ergänzt den Humangenetik-Konnektor, InterProScan erhält die Sequenzeinreichung, und der IEDB-Konnektor fügt Rezeptor-Evidenzsuchen hinzu. (#3278, #3280, #3304)
- **Ein besserer Start.** Die Oberfläche für neue Unterhaltungen vereint Recherche-Starters mit dem Eingabefeld, und die Sitzungskopfzeile erhält ein Menü häufiger Aktionen. (#3297, #3267)
- **Requesty-Anbieter.** Requesty ist jetzt im offiziellen Anbieter-Auswahlmenü mit kuratiertem Modellkatalog verfügbar. (#3114)

## 🚀 Neue Funktionen

- GWAS-Summary-Statistics-Discovery im Humangenetik-Konnektor: vollständige Summary-Statistics-Dateien, Metadaten und Referenzgenom-Informationen zu einer Studie finden. (#3278)
- Der InterProScan-Konnektor erhält eine begrenzte Sequenzeinreichung und vervollständigt den Workflow Einreichung → Status → Ergebnisse ohne manuelle Job-Erstellung. (#3280)
- Der IEDB-Konnektor ergänzt TCR- und BCR-Rezeptor-Evidenzsuchen neben Epitop- und Assay-Suche. (#3304)
- Überarbeitete Startoberfläche für neue Unterhaltungen: Recherche-Starters bleiben beim Entwurf einen Klick entfernt, mit kompakter Option zum Paketimport. (#3297)
- Das Menü der Sitzungskopfzeile bündelt häufige Aktionen: Sitzung bearbeiten und anheften, Seitenchat starten oder Verzweigung erstellen, Unterhaltung, Sitzungspaket oder Diagnosen exportieren sowie archivieren. (#3267)
- Requesty-Anbieter im offiziellen Anbieter-Auswahlmenü, mit kuratiertem Modellkatalog und integrierter Verbindungsprüfung. (#3114)

## 🔧 Verbesserungen

- Tabs und Werkzeugleiste des Seitenchats folgen dem kompakten Workspace-Layout. (#3275)
- Die Modellkataloge von OpenRouter und Requesty werden aktualisiert. (#3276)

## 🐛 Fehlerbehebungen

- **Replay und Sitzungen** — Weiterscrollen nach Folgefragen und aufgezeichnete Datei-Fragen bleiben im Replay erhalten (#3292); importierte Sitzungen bleiben schreibgeschützt (#3269); der Eingabebereich behält seinen Kontext, wenn sich die Sitzungsbindung ändert (#3306).
- **Notebook und Laufzeiten** — die Datei-Herkunft sprachübergreifender Notebooks wird korrekt projiziert (#3296); beschädigte Lauf-Dokumente werden isoliert, ohne die Wiederherstellung zu blockieren (#3294); R-Umgebungen bleiben bei Projektpfaden mit Leerzeichen erhalten (#3290).
- **PDF und Vorschau** — die Layout-Extraktion für Literatur ist für komplexe externe Paper gehärtet (#3286); der PDF-Kontext bleibt erhalten, bevor die erste Eingabe zugelassen wird (#3270); verifizierte PDF-Notizen werden projektübergreifend vereinheitlicht (#3264); dauerhafte Reader-Hinweise sind reduziert (#3274).
- **Agenten und Berechtigungen** — Einstellungen gemeinsamer Anmeldungen sind standardmäßig isoliert (#3289); unbeaufsichtigte Claude-Berechtigungsablehnungen werden im Workspace erklärt (#3287).
- **Workspace und Zuverlässigkeit** — die Titelleiste bleibt über Overlays und außerhalb portaler Oberflächen (#3285, #3307); Eingabebereich und Lesesymbole des Seitenchats sind ausgerichtet (#3301); Symbole der Sitzungskopfzeile überlappen nicht mehr (#3279); unaufgelöste Lesezeichen werden behandelt und Vorschau-Markierungen werden gelöscht (#3272); abgelaufene Artefakt-Transaktionen werden erneut versucht (#3295); zitierte Satzzeichen lösen keine Anmeldedaten-Fehlalarme mehr aus (#3271); Fehlschläge beim Erstellen von Lesezeichen werden mit ihrer Fehlerphase diagnostiziert (#3273).
