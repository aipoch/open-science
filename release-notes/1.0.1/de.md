## ✨ Highlights

- **Importieren Sie `.science`-Pakete direkt aus Ihrem Browser.** Eine Download-Seite kann nun per Klick ein Research-Paket an die Desktop-App übergeben — die App empfängt und validiert es automatisch, anschließend wählen Sie den Zielort und bestätigen den Import. Sowohl der Kaltstart als auch eine bereits laufende App werden unterstützt, und fehlgeschlagene Übertragungen melden mit strukturierten, umsetzbaren Fehlern, was passiert ist. (#3493)
- **Updates, die Sie nachvollziehen können — und denen Sie vertrauen können, besonders unter Windows.** Herunterladen, Bereitstellung und Installationsvorbereitung bleiben nun in einem einzigen Dialog mit unabhängig scrollbarer Versionsliste, statt dass Dialoge untereinander wechseln. Der Windows-Update-Pfad dupliziert das Installationsprogramm nicht mehr mit einem separaten Fortschrittsprozess, behält die Kontrolle über aus dem Explorer gestartete Nachfolgeprozesse und kopiert bei jedem Update nicht mehr tausende Dateien erneut; beim Beenden wartet die App zudem auf die Notebook-Bereinigung, und ein Kaltstart meldet keinen Netzwerkfehler mehr, bevor die App bereit ist. (#3653, #3633)
- **Sicherheitskorrekturen bei der Verarbeitung von MCP-OAuth-Anmeldedaten.** Gespeicherte OAuth-Anmeldedaten werden nun vor der Verwendung an den Autorisierungsserver gebunden, für den sie ausgestellt wurden, und aktualisierte Sicherheitspatches von Drittanbietern sind enthalten. (#3668)
- **Sessions, die auf Sie warten, werden immer als wartend angezeigt.** Eine Session, die auf Ihre Freigabe oder Antwort pausiert, springt nicht mehr kurz zurück auf „Läuft" — weder auf Home, in der Seitenleiste, bei Workspace-Aktionen noch im Gesprächskopf, und das über App-Neuladen und Live-Laufzeitaktualisierungen hinweg. (#3574)

## 🚀 New Features

- Der PDC-Connector ruft öffentliche Fall-bezogene klinische Metadaten ab — Demografie, Diagnosen, Tumorinformationen und Probenreferenzen — für die neueste oder eine bestimmte Studienversion. (#3614)
- Die Skill-Auswahl kann nun die Bilder berücksichtigen, die an Ihre aktuelle Nachricht angehängt sind, nicht nur den Text. (#3595)
- MiniMax M3.1 Flash, das veröffentlichte Modell mit 1M-Token-Kontext und multimodalem Eingabeformat, ist in beiden MiniMax-Regionen verfügbar. (#3670)
- Doppelklicken Sie eine Session in der Workspace-Seitenleiste, um den Session-Editor zu öffnen, statt über das Aktionsmenü zu gehen. (#3650)

## 🔧 Improvements

- Im eigenständigen Web-Workspace wird Compute aktiviert, sobald die benötigten Notebook- und Compute-APIs verfügbar sind, statt deaktiviert zu bleiben. (#3638)
- Settings öffnet wieder im Bereich „Allgemein", und Anbieterauswahl-Steuerelemente deaktivieren sich, während ein Speichervorgang läuft. (#3647, #3646)
- Die Anmeldedatenprüfung beim Windows-Start liefert Diagnoseinformationen, statt still zu schlagen. (#3631)
- Popover-Oberflächen passen sich den Farben des aktiven Designs an. (#3667)

## 🐛 Bug Fixes

- Wenn die App beendet wird, während eine anbieterseitige Frage ausstand, wird diese nicht mehr dauerhaft abgebrochen — nach einem Neustart kann sie weiterhin beantwortet werden. (#3672)
- Wird ein Gespräch gestoppt, während die neue Nachricht gerade gespeichert wurde, erreicht die gestoppte Nachricht den Anbieter nicht mehr. (#3660)
- Wiederholte MCP-Start-Aktivitätskennungen verhindern nicht mehr, dass Gesprächsänderungen gespeichert werden. (#3628)
- Die Start-Wiederherstellung behält ihre Wiederholungsautorität, wiederhergestellte Bibliotheksansichten werden aktualisiert, und Wiederherstellungsdialoge stapeln sich nicht mehr übereinander. (#3579)
- Memory-Bearbeitungen, die während eines ausstehenden Speichervorgangs vorgenommen wurden, werden beibehalten statt verworfen, und abgeschlossene Notebook-Läufe werden nach einem Neustart nicht mehr fälschlicherweise als unterbrochen gemeldet. (#3571)
- Manuelle Terminalbefehle bleiben in der Main-Agent-Ansicht sichtbar, auch wenn ein Subagent ausgewählt ist. (#3611)
- Die PDF-Lektüre wird weiter verbessert: Zweispaltiger Fließtext bleibt in der richtigen Reihenfolge, Abbildungen und Tabellen bleiben dem richtigen Element zugeordnet, übersetzte Reader-Layouts werden korrekt dargestellt, und die PDF-Suche weist nun darauf hin, wenn ihre Abdeckung unvollständig ist. (#3605, #3622, #3644, #3654, #3603)
- Literature: Gespeicherte Tool-Karten werden mit dem aktuellen Bibliotheksstand aktualisiert, der Vollbildmodus der Tabelle verwendet die korrekte Quelle, und der Speicherstatus wird zuverlässig aktualisiert. (#3645, #3629)
- Session-Paket-Import: Pakete können auf die Projekt-Home gezogen werden, Importprüfungen und Fortschritt sind übersichtlicher, und verschachtelte Dialoge scrollen korrekt. (#3649, #3648, #3673)
- Die Bearbeitung des Bodies eines Skills überschreibt keine separat bearbeiteten Namen oder Beschreibungen mehr, und Antikörpersuchen halten sich an ihre konfigurierten Ergebnisgrenzen. (#3570)
- Die automatisierte Prüfung wartet darauf, dass MCP-Server bereit sind, und verifiziert die geroutete Authentifizierung, bevor sie fortfährt. (#3597, #3627)
- Die Persistenz von „Als Skill speichern" ist auf die Session beschränkt, die ihn erstellt hat. (#3594)
- Das mobile Session-Bearbeiten behält sein Doppelklick-Verhalten. (#3651)
- Die erneute Erstellung der Agent-Laufzeit mitten in einer Session führt nicht mehr dazu, dass neue Skill-Aktivitäten mit historischen kollidieren — eine solche Kollision hat zuvor die Turn-Abwicklung und weitere Nachrichten blockiert. (#3682)
- Sessions mit vielen Reviews laden ihren Review-Verlauf wieder — der vollständige Verlauf hat zuvor das Transportbudget überschritten und das Review-Panel blockiert; einzelne Review-Protokolle werden nun bei Bedarf geöffnet. (#3677)
