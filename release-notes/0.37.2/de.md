## ✨ Highlights

- **Erholt sich von Laufzeitproblemen von selbst.** Startup repariert Fehler am Backend, in den Einstellungen und im Netzwerk ohne Neuinstallation; Laufzeitfehler werden isoliert, sodass die App weiter reagiert, und eine getrennte Laufzeit fesselt die App nicht mehr — Beenden bleibt verfügbar und eine manuelle Wiederverbindung wird angeboten. (#3525, #3414, #3528)
- **Große Snapshots von Sitzungen und Notebooks werden zuverlässig übertragen**, sodass das Wiederherstellen oder Verschieben schwerer Workspaces nicht mehr stehen bleibt oder auf halbem Weg fehlschlägt. (#3533)

## 🚀 Neue Funktionen

- Die Kommandozeile für Linux wird neben den bestehenden Archiven nun auch als eigenständige **.deb- und .rpm-Pakete** ausgeliefert. (#3491)
- Links zum Hilfe-Center und die Suche in den Einstellungen werden zusammen mit dem Rest der Oberfläche **lokalisiert**. (#3489)

## 🔧 Verbesserungen

- Die Weboberfläche bleibt bei starker Agentenaktivität reaktionsfähig — Ereignisstöße werden durch eine gemeinsame Sendewarteschlange begrenzt, und Laufzeit-Ereignisbatches werden nach kodierter Größe gedeckelt. (#3530, #3524)
- Umgeleitete Backend-Protokolle werden verdichtet, sodass Diagnoseordner klein bleiben. (#3535)

## 🐛 Fehlerbehebungen

- Die Strukturextraktion wissenschaftlicher PDFs hält Abbildungs- und Tabellenbesitz in mehr Layouts beim richtigen Element. (#3537)
- Die Abhängigkeits- und Dateiherkunftsanalyse von Notebooks ist gegen irreführende Beweise abgehärtet. (#3511)
- Komprimierung und Wiederholungsverhalten von Anbietern werden aus den Einstellungen wieder korrekt veröffentlicht. (#3520)
- Commits von Literaturmetadaten mit widersprüchlichen Identitäten werden abgelehnt, statt Datensätze zu beschädigen. (#3518)
- Literaturstatus bleibt über asynchrone Operationen hinweg erhalten. (#3504)
- Nachweise zur Wiederherstellung entfernter Aufträge überleben Abbruch und Bereinigung auf Rechenknoten. (#3506)
- Die Artenmetadaten von Bgee sind korrigiert. (#3505)
- Leere Bildanhänge werden in Agenten-Promptfehlern deutlich hervorgehoben. (#3513)
- Der Web-Startvorgang ist vereinheitlicht, und Wiederherstellungsdialoge warten, bis der Start tatsächlich abgeschlossen ist. (#3488)
- Die Erstvorbereitung des Notebooks zeigt den empfangenen Code an. (#3487)
- Hintergrundprozesse unter Windows blenden keine Konsolenfenster mehr auf. (#3519)
