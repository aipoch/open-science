## ✨ Highlights

- **Downloads sind deutlich kleiner.** CLI- und Desktop-Laufzeitpakete werden kleiner, indem ungenutzte generierte Komponenten entfernt, der Übersetzungs-Worker gegen seine kompakte Laufzeit gebündelt, ein einziger gebündelter Umgebungsmanager ausgeliefert und ungenutzte alternative Distributionen weggelassen werden — ohne aktive Laufzeitdateien oder Diagnose zu entfernen. (#3863, #3867)
- **Die eigenständige CLI spricht nun MCP.** Recherche-Werkzeuge werden über einen lokalen MCP-Server für externe MCP-Clients bereitgestellt — unter den bestehenden Berechtigungen des gewählten Profils, keine separate Sandbox und keine schreibgeschützte Ansicht; verbundene Clients können Schreibvorgänge dauerhaft speichern oder Modellkosten verursachen. (#3862)
- **Lange Unterhaltungen bleiben lesbar.** Sobald ein Turn abgeschlossen ist, klappen Zwischennachrichten während der Ausführung weg, während laufende, wartende und unterbrochene Arbeiten sichtbar bleiben; Werkzeuggruppen fassen sich zu Zusammenfassungen zusammen, und Suche, Anmerkungen sowie die native Suche zeigen versteckte Inhalte weiterhin bei Bedarf an. (#3868, #3866)
- **Literature erhält Integritätsprüfungen.** Referenzen mit einer DOI lassen sich auf Wunsch gegen Crossref auf Rücknahmen und Korrekturen prüfen, mit Ergebnissen und Prüfzeiten, die in der Referenz gespeichert werden. Die Abdeckung ist lückenhaft — wer keine Hinweise findet, hat damit nicht bewiesen, dass eine Referenz unbetroffen ist. (#3870)

## 🚀 New Features

- Die eigenständige CLI stellt ihre Recherche-Werkzeuge über einen lokalen MCP-Server für externe Werkzeugclients bereit. (#3862)
- Fragenkarten unterstützen strukturierte Auslassungsaktionen mit festen, vorhersehbaren Steuerungen. (#3813)
- Literature-Referenzen unterstützen explizite, je Referenz gestartete Prüfungen auf Rücknahme und Korrekturen über Crossref, manuell gestartet und nur für Einträge mit gültiger DOI. (#3870)
- Artefakte lassen sich nun aus von Ihnen autorisierten Ordnern importieren; die App liest die freigegebene Datei und bewahrt eine dauerhafte, unveränderliche Kopie in ihrem verwalteten Artefakt-Speicher auf. (#3882)
- Der GitHub-Import-Workflow für Fähigkeiten kann Repositorys für die Wiederverwendung speichern. (#3878)
- Gesprächstranskripte klappen Zwischennachrichten nach Abschluss eines Turns zusammen, mit Umschalttaste und vollständiger Wiederherstellung über Suche, Anmerkungen und die native Suche. (#3868)
- Werkzeugaktivitäten im Transkript fassen sich zu Gruppen zusammen, wobei laufende Werkzeuge während der Arbeit in einer Zusammenfassung angezeigt werden. (#3866)

## 🔧 Improvements

- CLI- und Desktop-Downloads sind plattformübergreifend kleiner dank beschnittener Laufzeitpakete, eines kompakten gebündelten Übersetzungs-Workers und eines einzigen gebündelten Umgebungsmanagers. (#3863)

## 🐛 Bug Fixes

- Windows: Die standardmäßige Notebook-Ausführung ist wiederhergestellt. (#3872)
- Die Lite-Laufzeit des Tokenizers bleibt in gebündelten Builds erhalten. (#3867)
- Der Sitzungspaket-Export wartet nach der Auswahl des Speicherorts nicht mehr aus. (#3874)
- Der Ordnerzugriffs-Dialog in den Einstellungen und sein Bereinigungsschritt kommen sich nicht mehr gegenseitig in die Quere. (#3877)
- Ask-user-Auswahlsteuerungen wiederholen sich nach einem Fortsetzungsfehler nicht mehr. (#3879)
- Replay stellt automatische Ergebnisse als Systemereignisse dar statt als mehrdeutige Nachrichten. (#3881)
