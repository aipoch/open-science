## ✨ Highlights

- **Intelligente Literatursammlungen.** Eine Sammlung kann ihre Referenzen jetzt anhand einer Beschreibung mit expliziten Einschluss- und Ausschlusskriterien sichten und sie in Aufgenommen, Überprüfung nötig, Ausgeschlossen und Nicht bewertet einsortieren — KI- und manuelle Entscheidungen werden unterschieden, einzelne oder ausgewählte Referenzen lassen sich bewerten, und optionale PDF-Evidenz, Entwurfsvorschauen, Abbruch, explizite Wiederholungen sowie auf Wunsch aktivierte automatische Aktualisierungen halten große Sichtungsvorhaben beherrschbar. (#2897)
- **Forschungspakete betten RO-Crate-Metadaten ein.** Neu exportierte `.science`-Pakete beschreiben ihren finalen Schnappschuss mit RO-Crate-1.1-Metadaten, verwenden ausgewählte unveränderliche Nutzdaten wieder und bauen Referenzen nach dem erneuten Export wieder auf. Bestehende Pakete bleiben ohne Migration lesbar. (#2869)
- **Drei neue Konnektoren.** Die Zenodo-Suche in öffentlichen Datensätzen durchsucht Einträge und ruft Metadaten und Dateiinventare ohne Authentifizierung ab (#2868); GDC-Tools listen Projekte und Fälle der Krebsgenomik auf, durchsuchen Datei-Metadaten und erzeugen Manifeste, ohne eine Download-Berechtigung zu suggerieren (#2896); das UniProt-Batch-Identifier-Mapping wandelt bis zu 100.000 Identifier datenbankübergreifend um und liefert nicht zugeordnete Ergebnisse explizit zurück. (#2881)
- **Ressourcenzugriffe pro Agent.** Die Einstellungen vereinen den Zugriff von Hauptagent und Spezialisten auf Fähigkeiten und Konnektoren an einem Ort — mit Nutzungsindikatoren unter jeder Ressource und einem einzigen Anpassungspunkt. (#2835)

## 🚀 Neue Funktionen

- Intelligente Literatursammlungen: beschreibungsgetriebene Sichtung mit Einschluss-/Ausschlusskriterien, die Zustände Aufgenommen / Überprüfung nötig / Ausgeschlossen / Nicht bewertet, Kennzeichnung von KI- gegenüber manuellen Entscheidungen, einzelne oder stapelweise Bewertung sowie auf Wunsch aktivierte automatische Aktualisierungen. (#2897)
- Diagnose-Export für Sitzungen: Der Sitzungskopf und das Seitenleisten-Menü können ausgewählte Diagnosequellen in einem einzigen lokalen Archiv bündeln — das Melden einer fehlerhaften Konversation bedeutet kein Suchen nach Dateien mehr. (#2867)
- Xiaomi MiMo v2.6-Modelle kommen mit Kontextfenstern von einer Million Token in die Anbieterauswahl; `mimo-v2.6-pro` wird zum Standard für neue Konfigurationen, während v2.5-Modelle für bestehende erhalten bleiben. (#2894)
- Grok 4.7 tritt dem xAI-Katalog als neuer Standard bei — mit einem Kontextfenster von 500.000 Token und Bildeingabe; bisherige Modell-IDs bleiben verfügbar. (#2887)
- Modelle der aktuellen Generation aktualisieren die Zen- und Go-Anbieterkataloge, wobei Protokoll, Kontext, Vision und Reasoning-Aufwand gegen die Gateway-Dokumentation geprüft wurden. (#2910)

## 🔧 Verbesserungen

- Streaming bleibt unter Last reaktionsfähig: Token-Schätzung und Streaming-Warteschlangen sind begrenzt, frameworkspezifische Assistant-Streams werden normalisiert, und Gedanken-Chunks werden verworfen, bevor sie den Renderer erreichen. (#2903, #2895, #2883)
- Die RO-Crate-Metadaten von Sitzungspaketen werden gestärkt: Alternative Dateinamen und MIME-Typen werden für gemeinsam genutzte Nutzdaten bewahrt, und widersprüchliche deklarierte Größen werden abgelehnt, bevor der Metadaten-Graph aufgebaut wird. (#2880)

## ⚠️ Kritische Änderungen

- Neu exportierte `.science`-Forschungspakete enthalten RO-Crate-Metadaten, die den final exportierten Schnappschuss beschreiben. Das Lesen neu exportierter Pakete erfordert einen Reader mit ro-crate-Unterstützung; bestehende Pakete bleiben ohne Migration lesbar, und die nativen Datenbank- und Evidenz-Schemata sind unverändert. (#2869)

## 🐛 Fehlerbehebungen

- **Agent-Laufzeit** – Nicht unterstützte Claude-CLI-Versionen werden mit einem klaren Bereitschaftssignal abgefangen, statt einen opaken Fehler beim Erstellen der Sitzung zu werfen (#2901); Fehler bei der Fallback-Übernahme überstehen ein fehlgeschlagenes Fortsetzen (#2906); veraltete aktive Ausführungen werden bereinigt, bevor neue Nachrichten angehängt werden (#2877).
- **Forschungspakete** – Die fälschliche Blockierung wegen Anmeldedaten-Export greift bei gewöhnlichen Paketen nicht mehr (#2904).
- **Notebook** – Hinweise zur Umgebung und zur Wiederherstellung im Hintergrund lassen sich schließen, sodass ein blockierter Bereich oder ein festhängender Toast nie einen Workaround erfordert (#2905, #2870); Windows R-Inventarabfragen laufen als einzeilige Skripte (#2899); Hilfseffekte bleiben für die Herkunftsverfolgung erhalten (#2834).
- **Plattform** – Das Windows-Paket-Reset-Tool entfernt schreibgeschützte Attribute im Verzeichnisbaum (#2902); Linux-Pakete bündeln die Fedora-Abfrage-Engine, sodass Fedora-basierte Systeme zuverlässig starten (#2886).
- **Oberfläche und Konnektoren** – Diagnose-Steuerungen vertragen langsamen Start, und der Export-Dialog wurde verfeinert (#2893, #2888); Suchhervorhebungen werden wiederhergestellt und PDF-Interaktionen stabilisiert (#2912); die Einstellungen für Ressourcenzugriffe laufen nicht mehr horizontal über (#2879); die Spezialisten-Wiederherstellungskarte bleibt über dem Composer-Dock (#2873); die MCP-Kataloge der Codex-Brücke entsprechen dem aktuellen Registry-Stand (#2885); UCSC-Konservierungsspuren der Maus verwenden den korrekten Standard (#2861).
