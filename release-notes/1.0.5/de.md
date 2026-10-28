## ✨ Highlights

- **Wissenschaftliche Recherche-Werkzeuge erreichen native Quell-APIs.** Europe PMC erhält direkte Boolesche, Kern- und Abstract-Suche mit expliziter Paginierung, dazu neue HGNC-Genmetadaten, ChEA3-Anreicherungsränge, bioDBnet-Konvertierungen und -Orthologie, Cellosaurus-RDF-Wissensgraphabfragen, STR-Ähnlichkeit sowie offizielle Dateiauffindung für NHANES, PhysioNet, openFDA und CTD — alles Opt-in und mit offiziellen URLs samt Herkunftsnachweis statt undurchsichtiger Downloads. Von Ihnen übermittelte Abfragen und Kennungen — Suchbegriffe, Gennamen, DOIs — werden an die jeweiligen öffentlichen Dienste gesendet, und zugangsbeschränkte Quellen werden ausschließlich mit offiziellen Zugangshinweisen aufgeführt; die App behauptet niemals, über Ihre Berechtigung zu verfügen. (#3869)
- **Lesefortschritt in Literature wird nachverfolgt.** Referenzen lassen sich als Ungelesen, In Bearbeitung oder Fertig gelesen markieren; der Status erscheint in einer eigenen Spalte, lässt sich direkt oder von der Detailseite aus bearbeiten, aktualisiert sich seitenübergreifend und inklusive Ausschlüssen im Massenbetrieb und filtert die Bibliothek mit konsistenten Zählungen und Auswahlbereich. (#3897, #3907)
- **Sitzungspakete funktionieren im Browser.** Lokale Web-Bereitstellungen können ein `.science`-Paket als Download exportieren und eines über eine Upload-Auswahl importieren — ganz ohne CLI-Ausweichlösung, wenn ausschließlich im Browser gearbeitet wird. Ein exportiertes Paket enthält die von Ihnen ausgewählten Gespräche, Dateien, Notebook-Einträge und Herkunftsnachweise, und Browser-Übertragungen laufen zwischen Ihrem Browser und Ihrem eigenen lokalen Dienst. (#3911)
- **Die Dienstlebensdauer folgt Ihrer Absicht.** Offen gehaltene App oder `open-science start` hält den lokalen Dienst am Leben; das Schließen eines Fensters stoppt ihn oder unabhängige Hintergrundarbeiten nicht mehr. Schlichtes `stop` gibt Ihre Haltebindung frei, und `stop --force` fordert ein Herunterfahren des gesamten Dienstes an. Solange eine Haltebindung aktiv ist, laufen der Dienst und seine Hintergrundarbeiten weiter, bis Sie die Haltebindung aufheben oder das Herunterfahren erzwingen. (#3769)

## 🚀 New Features

- Die Startseite erhält eine Anwendungsfall-Galerie: veröffentlichte Beispiele durchsuchen, ihre Details öffnen und ein verifiziertes Sitzungspaket mit Download-Fortschritt und Abbruch importieren. (#3901)
- Manuelle Update-Einstiegspunkte: dauerhafte Download- und Anleitungslinks in den Einstellungen und Update-Oberflächen, dazu ein schreibgeschützter Befehl, der den bestätigten Installer aufdeckt. (#3902)
- Einstellungen → About verlinkt die Sicherheitsrichtlinie des Projekts. (#3906)
- Autorisierte Verzeichnisse werden als kompakte Ordnerliste mit Lese-/Schreibabzeichen und Tooltips zum Zeitpunkt der Gewährung dargestellt statt als rohes JSON. (#3871)

## 🔧 Improvements

- DOCX-Berichte bewahren beabsichtigte Tabellenstile, Rahmen und Seitenlayout während Erzeugung und Vorschau, und ein gepflegter, vorlagenbasierter Markdown-nach-DOCX-Konvertierungsworkflow ist auf Abruf verfügbar. (#3811)
- Ergebnisse der Publikationsprüfung bieten genau eine kurze Aktion mit Crossref-Nennung und Zeitpunkt der letzten Prüfung. (#3896)
- Referenzdetails fassen Schlagwörter und Typ in der Kopfzeile zusammen, wiederholende Erläuterungen wurden entfernt. (#3910)
- Oberflächen für importierte Sitzungspakete und Replay verzichten auf redundante Diagnostik und geben ihren Aktionen konsistente, sichtbare Grenzen. (#3908)
- Windows-verwaltetes R erklärt bei Bioconductor-Paketen nun die explizite Route über BiocManager, statt mit einem generischen Conda-Fehler abzubrechen. (#3918)

## 🐛 Bug Fixes

- Vollzugriffs-Sitzungen lassen öffentliche Netzwerkziele ohne Genehmigungsabfragen zu, und die Herabstufung von Vollzugriff schließt bestehende Verbindungen. (#3898)
- Einstellungen → Netzwerk spiegelt sofort global gewährte Domains aus Genehmigungsdialogen wider. (#3900)
- OpenCode-2.x-Laufzeiten starten und funktionieren wieder, wobei der 1.x-Pfad erhalten bleibt. (#3903)
- macOS-Notebooks finden CLI-Werkzeuge, deren Node-Laufzeit außerhalb des geerbten PATH der App liegt. (#3916)
- Windows-Chats warten nicht mehr auf die Schutzkonfiguration, bevor eine Anbieteranfrage startet. (#3922)
- Notebooks lesen anwendungsverwaltete Referenzdateien von Fähigkeiten ohne Ordnerzugriffsabfrage. (#3920)
- Eingeklappte Werkzeuggruppen bewahren Ihre Leseposition. (#3873)
- Breite Markdown-Tabellen zeigen ihre Bildlaufleiste bei Hover und Tastaturfokus. (#3875)
