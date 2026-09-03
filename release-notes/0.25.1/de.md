## ✨ Highlights

- **Geschützte Notebook-Kernel starten direkt unter Windows.** Kernel unter Windows starten innerhalb der Netzwerk-Sandbox – ohne den indirekten Startpfad, der sie ungeschützt ließ oder am Start hindern konnte. (#2081)
- **Dateiexporte werden atomar veröffentlicht.** Exportierte Dateien erscheinen erst, wenn sie vollständig geschrieben sind; ein fehlgeschlagener oder abgebrochener Export kann keine unvollständige Datei mehr zurücklassen, und Paketexporte behalten über Zeitzonen hinweg gültige Zeitstempel. (#2070, #2072)
- **Vorschauen generierter Bilder sind wiederhergestellt.** Bilder, die der Agent erzeugt, zeigen ihre Vorschauen wieder, statt auf Platzhalter zurückzufallen. (#2082)
- **Inkonsistenzen im Fähigkeitskatalog beheben sich selbst.** Die Einstellungen erkennen und reparieren Katalog-Inkonsistenzen, statt Fähigkeiten fehlen zu lassen oder doppelt zu zeigen. (#2080)

## 🐛 Fehlerbehebungen

- **Notebook und Compute** – Grenzwerte für die Sitzungs-Parallelität überstehen Neustarts (#2077); die Wiederherstellung des Artefakt-Abschlusses bleibt nach einem fehlgeschlagenen Versuch wiederholbar (#2068); und veraltete Laufzeitauswahl-Verträge blockieren den Kernelstart nicht mehr. (#2073)
- **Dateien und Artefakte** – der PDF-Lesekontext behält die logische Dateiidentität, wenn die zugrunde liegende Datei ersetzt wird (#2094); und Bearbeitungen an Sitzungsdetails überschreiben sich nicht mehr gegenseitig mit veralteten Daten. (#2079)
- **Sitzungen und Speicherung** – veraltete Kombinationen der Sitzungswiederherstellung werden beim Start normalisiert (#2092); Task-Interaktionen werden vor dem Persistieren zugelassen, damit Arbeiten in der Warteschlange nicht verloren gehen (#2078); und die Bereinigung verwandter Daten erholt sich nach einem Löschfehler und läuft weiter. (#2074)
- **Agenten und Anbieter** – abgeschlossene Nutzungsdaten von Claude-Modellaufrufen werden in die Nutzungsstatistiken übernommen (#2086); CodeBuddy bewahrt leere Befehlsargumente unter Windows (#2089); und Spezialisten-Pakete erholen sich von Unterbrechungen und geben klare Hinweise zu ihrer Quelle. (#2076)
- **Arbeitsbereich und Einstellungen** – die App räumt Renderer-Lebenszyklus-Listener auf, die sich über lange Sitzungen hinweg ansammeln konnten (#2083); und Inkonsistenzen im Fähigkeitskatalog werden automatisch erkannt und repariert. (#2080)
