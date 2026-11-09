## ✨ Highlights

- **Aufträge auf Cloud-Backends ausführen.** Kubernetes, Hugging Face Jobs, Modal und Ray ergänzen SSH und Slurm: Ziel, Befehl, Ressourcen und Ausgaben werden vor dem Absenden genehmigt, der Auftrag wird nach einem Neustart wiederhergestellt, und veröffentlichte Ergebnisse lassen sich aus der Compute Preview öffnen. (#4191)
- **Integrierter Open-Science-Agent.** Eine eigenständige, integrierte Agent-Laufzeit mit anbieterneutraler Ausführung von Zügen und validierter Werkzeugbehandlung ist nun die Standardeinstellung für neue Einrichtungen (zuvor Claude); Claude Code, OpenCode, Codex, CodeBuddy und Pi bleiben verfügbar. (#4147, #4159)
- **Schnellere macOS-Aktualisierungen.** Aktualisierungen laden nur die geänderten Blöcke des App-Abbilds herunter und greifen bei Bedarf auf den vollständigen Download zurück. (#4177)
- **Importierte Forschung an einem Schritt diskutieren.** Fragen aus einem importierten `.science`-Paket oder einem Wiedergabeschritt öffnet eine untergeordnete Unterhaltung, die mit diesem Schritt verknüpft ist; die übergeordnete Unterhaltung behält ihre Identität, und Diskussionen überleben das Archivieren. (#4178)
- **Ein ruhigerer Arbeitsbereich.** Die Seitenleiste beginnt mit angepinnten und importierten Untersuchungen und fasst ältere Sitzungen in einer einzigen Liste zuletzt verwendeter Einträge zusammen, der Importverlauf macht „Fork to continue“ zum eindeutigen nächsten Schritt, und das Senden aus einem früheren Zug springt nicht mehr aus der Leseposition. (#4180, #4183, #4188)
- **Verlässlichere Aktualisierungen und Dokumente.** macOS prüft die laufende App, bevor eine Installation blockiert wird, Windows-Aktualisierungen nennen die Dateien, die die App geöffnet halten, und die Übersetzung fester PDF-Layouts bewahrt gesunde Seiten, wenn eine Seite fehlschlägt. (#4161, #4158, #4186)

## 🚀 New Features

- Genehmigte Aufträge an Kubernetes, Hugging Face Jobs, Modal oder Ray absenden, mit Genehmigung von Ziel, Befehl, Ressourcen und Ausgaben pro Auftrag sowie Wiederherstellungsdatensätzen, die die Erfassung nach einem Neustart fortsetzen. Remote-Aufträge laufen unter der Berechtigung Ihres eigenen verbundenen Kontos: Jedes Backend benötigt eigene Anmeldedaten, und die genehmigten Eingaben, der Befehl und die Ausgaben verlassen diesen Rechner für den ausgewählten Anbieter. (#4191)
- Die integrierte Open-Science-Agent-Laufzeit nutzen, mit Streaming-Adaptern für gängige API-Protokolle und persistenten Speichern; sie ist die Standardlaufzeit für neue Installationen. (#4147, #4159)
- macOS-Aktualisierungen differenziell über Blockmaps herunterladen, mit automatischem Rückgriff auf den vollständigen Download. (#4177)
- Eine schrittverknüpfte untergeordnete Diskussion aus importierten Untersuchungen oder der Wiedergabe eröffnen; das Löschen der übergeordneten Unterhaltung wandelt Diskussionen in gewöhnliche Unterhaltungen um. (#4178)
- Quelllinks in einer Hover-Karte mit Zieldomäne und, für freigegebene HTTPS-Quellen, Metadaten zu Titel und Beschreibung anzeigen. (#4194)

## 🔧 Improvements

- Die Seitenleiste des Arbeitsbereichs ordnet Gruppen als Angepinnt, Importierte Untersuchungen, Aktiv und Zuletzt verwendet an, und untergeordnete Sitzungen sind klar als Zweige ihrer übergeordneten Unterhaltung erkennbar. (#4180)
- Der Importverlauf behält alle vier Aktionen, stellt aber Fork to continue als einzige primäre Aktion voran. (#4183)
- Das Senden einer Eingabe während des Lesens eines früheren Zugs hält das Protokoll verankert, statt ans Ende zu springen. (#4188)
- Der Reiter Modell in den Einstellungen wird zu Lokalen Fähigkeiten und deckt PDF-Extraktion, OCR-Sprachpakete und Forschungsnarration in abgestimmten Karten ab. (#4175)
- Fragen in der Wiedergabe werden an den ausgewählten Schritt oder Notebook-Lauf angehängt, einschließlich Zellen außerhalb der aktuellen Seite. (#4187, #4185)
- Werkzeugfehlermeldungen nennen jetzt den fehlgeschlagenen Aufruf und den konkreten nächsten Schritt, statt so zu lesen, als sei das Werkzeug nicht verfügbar. (#4184)
- Die Analyse großer Quellen im Notebook läuft außerhalb des Hauptthreads, Dateibelege nutzen einen residenten Worker erneut, und der Abgang eigener Prozesse wird nativ abgewartet, was Läufe und Beendigungen reaktionsschnell hält. (#4166, #4174, #4169)
- Die externe PDF-Extraktion aus der Literatur stellt nur belegte native Prosa-, Mathematik- und Tabellenfragmente wieder her und lehnt täuschend ähnliche Bildunterschriften und Zitationsenden ab. (#4156, #4176)
- Das manuelle Formular Referenz hinzufügen akzeptiert Einträge nur mit Kennung wie einer PMID und erzeugt einen Titel aus der ersten Kennung. (#4150)
- Die Exportsteuerungen für Forschungsfilme bleiben während des Fortschritts kompakt, und der Film-Button blinkt beim Laden seines Status nicht mehr die falsche Aktion auf. (#4182, #4179)

## 🐛 Bug Fixes

- Aliase von DeepSeek-Modellen werden über Chat Completions geleitet, wodurch Validierungs- und Laufzeitfehler auf dem Responses-Pfad behoben werden. (#4192)
- Verwaltete R-Umgebungen unter Windows starten Rscript mit den aktivierten Conda-DLL-Verzeichnissen und beheben damit Abgänge mit STATUS_DLL_NOT_FOUND. (#4195)
- Unter Windows mit Anzeigeskalierung begrenzt sich das Hauptfenster auf den Arbeitsbereich der Anzeige, sodass die Taskleiste den Eingabebereich nicht mehr überdecken kann. (#4200)
- Die Übersetzung fester PDF-Layouts behält unabhängig übersetzte Seiten bei, wenn eine Seite ein nicht unterstütztes Layout hat, statt die gesamte Vorschau zu verwerfen. (#4186)
- Prüfungen der Update-Installation verifizieren das laufende macOS-Bundle, bevor sie Installation-beschäftigt melden, nennen die Windows-Prozesse, die App-Dateien geöffnet halten, und beheben Blocker, ohne die App zu blockieren. (#4161, #4158, #4153)
- Der gemeinsame macOS-Hintergrunddienst löst sich vom Absturzbehandler des Desktops, sodass ein veralteter Behandler keine Dateien mehr hält oder Updates blockiert. (#4165)
- Startdiagnosen überleben den automatischen Neustart nach dem Abgang eines Backends. (#4144)
- Die Wiederherstellung der Notebook-Laufzeit unter Windows weist nach, dass der Kernel-Prozessbaum beendet ist, bevor Start-Sperren aufgehoben werden, und Terminalaufgaben bevorzugen das verwaltete Node der App gegenüber systemweiten Ersatzprogrammen. (#4140, #4142, #4143)
- Die Laufzeitbereinigung von Codex löst taskkill zuverlässig in eingeschränkten Windows-Umgebungen. (#4199)

## 🙏 Danksagungen

Danke an [@daanveer-tech](https://github.com/daanveer-tech) für die Abstimmung der v1.1.0-Versionsdetails über die lokalisierten READMEs hinweg. ([#4146](https://github.com/aipoch/open-science/pull/4146))
