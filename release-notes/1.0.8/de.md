## ✨ Highlights

- **Die Einstellungen sind jetzt in übersichtliche Tabs gegliedert.** Die allgemeinen Einstellungen sind auf dedizierte Tabs verteilt: Darstellung und Benachrichtigungen ziehen unter die Systemeinstellungen, während der Bereich Allgemein jetzt App-Informationen, Diagnose, Befehlszeilenwerkzeuge und Hilferessourcen zeigt — einschließlich eines direkten Links zur Anleitung für manuelle Installation und Aktualisierung — ohne Umwege. (#4022)
- **Referenzen in Stapeln aus DOI, arXiv oder PubMed importieren.** »Aus DOI oder Link hinzufügen« akzeptiert jetzt bis zu 100 gemischte Kennungen pro Import — DOI, arXiv-ID, PMID, PMCID oder offizielle Artikellinks — normalisiert und dedupliziert sie, bevor die gewohnte Prüfung und die transaktionale Speicherung erfolgen. (#4039)
- **KI-Studienübersichten für die Literatur.** Die Literaturdetailansicht erhält eine Karte mit KI-Übersichten, die eine Publikation in fünf strukturierte Abschnitte zusammenfasst — Forschungsfrage, Studienpopulation, Methoden, Hauptergebnisse und Einschränkungen — erstellt mit Ihrem konfigurierten Hauptmodell aus dem Volltext oder dem Abstract und gekennzeichnet danach, welche Quelle verwendet wurde. (#4037)
- **Beendete Sitzungen geben ihre Agenten-Prozesse frei.** Abgeschlossene Sitzungen über alle fünf Agenten-Frameworks hinweg stapeln keine Anbieter- und Werkzeugprozesse mehr im Speicher: Gemeinsame Prüf-Laufzeiten, ersetzte Übergabe-Leases und fehlgeschlagene Aufräumversuche werden freigegeben oder bis zur Bestätigung erneut versucht, sodass lange Arbeitstage mit vielen Sitzungen reaktionsfähig bleiben. (#4046, #4054, #4061)

## 🚀 New Features

- Tencent TokenHub erhält das Reasoning-Modell Hy4 und aktuelle DeepSeek-V4.1-Flash-Routen mit Kontextfenstern von 1.000.000 Token sowie Bild-Eingabe für GLM-5.3-Flash, Kimi K3 und MiniMax M3. (#4060)

## 🔧 Improvements

- eQTL-Catalogue-Abfragen funktionieren wieder, nachdem die REST-API des Upstream-Anbieters eingestellt wurde; sie nutzen jetzt indexierte Dateien und prüfen, dass Koordinaten die Assemblierung GRCh38 verwenden, statt still irreführende Treffer zurückzugeben. (#4036)
- Die Lesereihenfolge und Extraktion von PDFs ist zuverlässiger: Die automatische Sortierung nutzt positionierte Textnachweise, um Prosa-Spalten von Tabellenzeilen zu unterscheiden, Zuschnittgrenzen werden gegen die native Quelle geprüft, mehrdeutige Tabellenzellen behalten ihren Originaltext mit einer Zuverlässigkeitswarnung, und der Windows-PDF-Worker stürzt beim Abbau nicht mehr ab. (#3994, #4056)
- Aktualisierungsdialoge nennen jetzt den blockierenden Prozess statt vollständige Systempfade auszugeben, und Fehler bei der Wiederherstellung der Desktop-Anwendung behalten ihre tatsächliche Fehler-Evidenz in Diagnosepaketen und Protokollen, statt nur eine allgemeine Fehlermeldung zu melden. (#4047, #4045)
- Die Reproduktionsabdeckung für R-Analysen ist ehrlicher: Wissenschaftliche Aufrufe, die Argumente erzwingen oder Methoden dispatch können, widerrufen jetzt veraltete Datei-Beweise, sodass die nachgelagerte Verifikation nicht mehr vortäuscht, von welchen Dateien ein Ergebnis abhing. (#4052)

## 🐛 Bug Fixes

- macOS-Aktualisierungen werden nicht mehr durch gewöhnliche schreibgeschützte Datei-Inhaber wie den StoreKit-Agenten blockiert, und Windows stuft die eigenen Backend-Prozesse der Anwendung bei der Aktualisierungsvorbereitung nicht mehr als fremd ein. (#4028)
- Die Windows-Aktualisierungsprüfung meldet nicht mehr eine unbekannte Belegung, wenn Systemwerkzeuge im PATH fehlen oder Prüfungen lange laufen, und veraltete Notebook-Quittungen blockieren die Wiederherstellung nach der Wiederverwendung einer Prozess-ID nicht mehr. (#4042)
- Ein gespeicherter Download endet nicht mehr mit einem Berechtigungsfehler, wenn das Zielverzeichnis selbst nicht lesbar ist; die vollständige Datei bleibt bestehen. (#4053)
- Sandboxed Notebook-Befehlszeilenwerkzeuge greifen auf die eigene Node-Laufzeit der Anwendung zurück, wenn die PATH-Version zu alt ist, um den konfigurierten Proxy zu nutzen; damit funktioniert der Netzwerkzugriff in der Sandbox. (#4058)
- Windows-Schutzprüfungen schließen zwischen den Prüfungen nicht mehr ein gesundes gemeinsames Gateway und melden keinen fälschlichen Laufzeitfehler. (#4029)
- Eine erneute Suche nach einer Publikation löscht die vorherige Meldung »PDF konnte nicht hinzugefügt werden«, sobald die neue Suche erfolgreich ist. (#4041)
- Pi wird jetzt in der paketierten Desktop-Anwendung korrekt installiert, statt bei der Suche nach seinen Bootstrap-Dateien zu scheitern. (#4027)
- Der Eingabebereich zeigt neben dem Modellstatus im Modellwähler keine doppelte Meldung über ein nicht verfügbares Modell mehr. (#4051)
- Ein Artefakt-Download, der abschließt und dann beim Freigeben seiner Fähigkeit fehlschlägt, entkommt nicht mehr als unbehandelter Fehler, der das Backend beenden kann. (#4055)
- Markdown-Artefakte reparieren beim Öffnen einen von älteren Versionen hinterlassenen veralteten Provenienz-Kopf, und das Provenienz-Panel erklärt unvollständige Ausführungs-Evidenz jetzt ausdrücklich. (#4021)
