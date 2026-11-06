## ✨ Highlights

- **Portable Forschungsfilme.** Exportieren Sie eine Sitzung als portablen, kommentierten Forschungsfilm zum Teilen: Die Sprachausgabe-Assets werden zuerst über das integrierte CDN der Anwendung heruntergeladen, mit einem fixierten Upstream-Fallback, die Generierung führt Vorabprüfungen durch und erholt sich von Fehlern, das Terminal-Timing wird für stabile Ausgaben eingefroren, und verwendbare Modelle erfordern keine vorherige Protokollvalidierung mehr. (#4077, #4102, #4104, #4106, #4114)
- **Literaturwerkzeuge in der CLI und MCP.** Durchsuchen und verwalten Sie die Literaturbibliothek von der Befehlszeile und aus MCP-Clients — mit schreibgeschütztem Durchsuchen sowie Schreibwerkzeugen zum Aktuellhalten von Referenzen. (#4120, #4122)
- **Fortsetzbare Stapelübersichten von Publikationen.** Die Stapelgenerierung von Übersichten setzt nach Unterbrechungen an der Stelle wieder auf, ohne bereits fertige Ergebnisse erneut zu erzeugen. (#4095; thanks [@nasus2002](https://github.com/nasus2002))
- **Überarbeitetes Ressourcenzentrum.** Das Ressourcenzentrum wurde umbenannt und das Layout der Fallbibliothek angepasst, externe Ressourcenlinks in den Einstellungen sind kompakter, und die Recheneinstellungen ziehen in die Verbindungsgruppe um. (#4018, #4090, #4087)
- **Optionale Ressourcenaufzeichnung (Windows).** Die Diagnose kann die Ressourcennutzung während der Arbeit aufzeichnen — Prozessidentitäten, Sitzungsaktivität und zugesicherten Systemspeicher — und die Evidenz in ein exportiertes Diagnosearchiv aufnehmen, mit einer Abtastung, die pausiert, wenn der Rechner im Leerlauf ist oder sich im Standby befindet. (#4062)
- **Mobiles Gerät verbinden.** Koppeln Sie ein Telefon oder Tablet durch Scannen eines QR-Codes und öffnen Sie den aktuellen Arbeitsbereich darauf — über lokales WLAN oder durch einen Pinggy-Tunnel mit automatischer Wiederverbindung und Regionsauswahl; Internet-Tunnels weisen darauf hin, dass der Datenverkehr über die Server von Pinggy läuft. (#4129)

## 🚀 New Features

- Exportieren Sie jede Sitzung als portablen Forschungsfilm mit Terminal-Wiedergabe und Sprachausgabe. (#4077)
- Nutzen Sie die Werkzeuge der Literaturbibliothek über die CLI und MCP: schreibgeschützte Suche und Recherche sowie Schreibwerkzeuge zur Verwaltung von Referenzen. (#4120, #4122)
- Zeichnen Sie die Ressourcennutzung über die Diagnose unter Windows auf, um Ressourcenerschöpfung zu diagnostizieren — mit Steuerung zum Starten und Stoppen und Evidenz in exportierten Archiven. (#4062)
- Koppeln Sie ein mobiles Gerät durch Scannen eines QR-Codes und öffnen Sie den aktuellen Arbeitsbereich darauf — über lokales WLAN oder durch einen Pinggy-Tunnel. (#4129)

## 🔧 Improvements

- Unterhaltungen erholen sich nach Unterbrechungen und Speicherfehlern, statt den aktiven Austausch zu verlieren. (#4097)
- Diagnoseexporte bewahren die Ausführungsevidenz des Notebooks, zeichnen Diagnosedaten des Exportschnappschusses auf, erlauben die Auswahl historischer Backend-Protokolle und behandeln gewöhnliche Protokollfilterung als erfolgreichen Export. (#4083, #4086, #4063, #4108)
- Die PDF-Strukturextraktion stellt Abbildungen und Tabellen aus durchsuchbaren Scans wieder her, statt sie zu verwerfen, und bewahrt native Zuschnittgrenzen und Textprovenienz. (#4078, #4132)
- Eingeschränkte OpenCode-Inferenzaufrufe erzwingen keine Zusammenfassungen mehr, und die Ausgabe eingeschränkter Inferenz ist über alle Agenten-Frameworks hinweg konsistent. (#4119, #4115)
- Die Wiederverwendung ungenutzter ACP-Verbindungen ist begrenzt, was das Speicherwachstum an langen Arbeitstagen reduziert. (#4103)
- Die Windows-Aktualisierungsvorbereitung erfragt Prozessidentität und Belegung nativ, statt auf externe Systemwerkzeuge angewiesen zu sein. (#4069)
- Der Start wartet vor dem Zeitüberschreitungslimit für den ersten Client auf die Discovery und bewahrt den Fehlerstatus über die Laufzeitbereinigung hinweg. (#4082, #4070)
- Der Import-Marktplatz wählt das aktuelle Projekt vor und verwendet vereinfachte Beschriftungen. (#4109, #4105)
- Die Literatur klärt die Beschriftungen für den Kennungsimport und bewahrt unvollständige PDFs nach Fehlern bei der Generierung. (#4072, #4113)
- Molekülexporte bewahren große Strukturen in Molfiles. (#4075)
- CodeBuddy-Skills lösen ihre Ressourcen für native und WSL-Werkzeuge auf. (#4076)
- Arbeitsbereichspanels besitzen mit dem Zeiger mitlaufende Ziehpunkte zur Größenänderung. (#4131, #4133)

## 🐛 Bug Fixes

- Das Notebook bevorzugt die bereite verwaltete Standardlaufzeit, fehlgeschlagene Shell-Ausführungen werden als MCP-Fehler gemeldet, und ein fehlgeschlagener Lauf bedeutet nicht mehr, dass alle Läufe fehlgeschlagen sind. (#4101, #4112, #4093)
- Die Wiederherstellung des Renderers bleibt während Laufzeitvorgängen nicht mehr stehen. (#3972)
- Arbeitsbereichspanels bleiben innerhalb des Ansichtsbereichs, und ausstehende Rückfragen sind vereinfacht. (#4107, #4094)
- ACP setzt Rückfragen-Fortsetzungen nicht mehr vorzeitig wieder fort. (#4096)
- Der Netzwerkzugriff des Notebooks folgt einer einheitlichen HTTPS-Richtlinie mit ausdrücklicher Freigabe unsicherer Endpunkte, und die Codeprüfung meldet keine falschen Risikohinweise mehr für skalare Rückrufe. (#4098, #4130)
- Native Bilder werden auf der Codex-Chat-Brücke angezeigt. (#4128)
- Die Speicherbelege einer Sitzung überleben die Wiederherstellung verdichteter Felder, und das Löschen einer Sitzung wartet nicht mehr auf eine Framework-Neuverbindung. (#4123, #4121)
- Der Export eines Forschungsfilms als MP4 von einem verbundenen Desktop öffnet wieder den Speicherdialog, statt zu scheitern. (#4126)
