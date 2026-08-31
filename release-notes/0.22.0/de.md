## ✨ Highlights

- **Persistente Agentenerinnerungen.** Der Agent kann sich nun sitzungsübergreifend an wichtige Informationen erinnern. Die optionalen, in projektbezogenen Kategorien organisierten Einträge werden automatisch abgerufen, sobald eine Konversation sie berührt. In den Einstellungen lassen sich alle Einträge anzeigen, bearbeiten und löschen. (#1432)
- **Provenienzbewusste Workflows für Abbildungen.** Die integrierten wissenschaftlichen Fähigkeiten erhalten registrierte Hilfsprogramme für die Gestaltung von Abbildungen, die Zusammenstellung mehrteiliger Abbildungen und publikationsreife Erläuterungen. Sie bauen auf unveränderlichen Artefakteingaben auf, sodass jede Abbildung auf ihre Ausgangsdaten zurückgeführt werden kann. (#1864)
- **Zentrale Verwaltung von Anmeldeinformationen.** GitHub-Tokens, Konnektor-Schlüssel und Konnektor-Anmeldungen werden an einer Stelle verwaltet. Der Status ist sofort erkennbar, fehlerhafte Anmeldeinformationen lassen sich geführt wiederherstellen und betroffene Konnektoren werden anschließend automatisch erneut geprüft. (#1865)
- **Ein vollständigeres Bild der Nutzung.** Das Nutzungsdashboard ordnet den Token-Verbrauch nun der jeweiligen Ausführung zu und berücksichtigt Modellaufrufe außerhalb der Hauptkonversation, einschließlich Seitenkonversationen, Delegation und Kontextkomprimierung. (#1877, #1874)

## 🚀 Neue Funktionen

- **Persistente Agentenerinnerungen** – optionale, projektbezogene Erinnerungskategorien, die der Agent vor relevanten Interaktionen abruft. Einträge können in einem eigenen Einstellungsbereich erstellt, korrigiert und gelöscht werden. Der Abruf bleibt auf das Projekt der Konversation beschränkt, damit unabhängige Arbeiten nicht vermischt werden. (#1432)
- **Zentrale Verwaltung von Anmeldeinformationen** – ein gemeinsamer Bereich für persönliche GitHub-Zugriffstokens, Konnektor-API-Schlüssel und Konnektor-Anmeldungen mit Statusanzeige, geführter Wiederherstellung und Unterstützung für Schlüssel kostenloser, ratenbegrenzter Tarife offener Datenquellen. (#1865)
- **Tencent TokenHub als Modellanbieter** mit Endpunkten für internationale Nutzer und das chinesische Festland sowie einer ersten Auswahl an Tencent-Modellen. (#1880)
- **Provenienzbewusste Workflows für Abbildungen in integrierten Fähigkeiten** – registrierte Hilfsprogramme für Gestaltung, mehrteilige Komposition und publikationsreife Erläuterungen verarbeiten unveränderliche Artefakteingaben und halten Abbildungen damit auf ihre Ausgangsdaten zurückführbar. (#1864)
- **Nutzungszuordnung pro Ausführung** – die Token-Nutzung wird der verursachenden Ausführung zugeordnet und dauerhaft gespeichert, sodass das Dashboard auch nach Neustarts korrekte Werte anzeigt. (#1877)

## 🔧 Verbesserungen

- Das Nutzungsdashboard berücksichtigt nun auch Modellaufrufe außerhalb der Hauptkonversation, etwa Seitenkonversationen, Delegation und Kontextkomprimierung. Die Summen entsprechen dadurch besser der Abrechnung des Anbieters. (#1874)
- Erweiterte Zeilen für geladene Fähigkeiten zeigen das Fähigkeitsdokument als formatiertes Markdown an, bieten bei Ladefehlern eine Wiederholungsoption und lassen sich ohne Sprünge der Bildlaufposition öffnen. (#1812)
- Ein fehlgeschlagener Update-Download führt nicht mehr in eine Sackgasse: Der Update-Dialog bleibt bedienbar und kann den Download sofort wiederholen. (#1868)
- Update-Downloads und Runtime-Installationen wurden abgesichert: Update-Manifeste werden vor der Verwendung validiert, Installationsprogramme müssen von der vertrauenswürdigen Quelle stammen und abgebrochene Installationen werden vollständig bereinigt. (#1873)
- Fehlerausgaben des Agenten werden zusammengefasst, statt vollständig in Protokolle geschrieben zu werden. So bleiben normale Forschungsausgaben und lokale Pfade aus der Diagnose heraus; Rohbeispiele stehen weiterhin als optionale Supportfunktion bereit. (#1858)
- Die CodeBuddy-Runtime sendet keine Runtime-Fehlerberichte mehr. (#1856)
- Die Modellauswahl erklärt nun, warum ein Modell nicht verfügbar ist, anstatt es kommentarlos zu deaktivieren. (#1879)
- Die Task-API und die CLI-Ereignisstreams verfügen über stabile Ausführungskennungen und begrenzte Wiederholungen. Clients können sich erneut verbinden, ohne aufeinanderfolgende Ausführungen zu vermischen; widerrufene oder abgeschlossene Streams versuchen nicht mehr endlos, die Verbindung wiederherzustellen. (#1875)
- Pflichtfelder und Feldfehler sind nun für Hilfstechnologien zugänglich. (#1869)

## 🐛 Fehlerbehebungen

- **Claude-Backend** – unterbrochene Claude-Antworten werden fortgesetzt, statt hängen zu bleiben (#1853); Loopback-Anmeldeinformationen überstehen Neustarts und Neukonfigurationen (#1878, #1859); vom Agenten erteilte Tool-Berechtigungen werden nicht mehr durch veraltete Einstellungen verdeckt (#1848).
- **Sitzungen** – eine ausgelastete erste Interaktion verbirgt die Agentenantwort nicht mehr, wenn die Erstellung von Sitzungsdetails und die Nutzungsverbuchung gleichzeitig erfolgen (#1876); aufeinanderfolgende Verwaltungsaktualisierungen werden zuverlässig wiedergegeben (#1860).
- **Lokaler und Headless-Dienst** – gleichzeitige Anfrageinhalte und WebSocket-Übertragungen sind begrenzt, und blockierte Clients werden getrennt, damit der Localhost-Dienst auch unter Last reagiert (#1857).
- **Lange Ausführungen** – rohe Runtime-Ereignisse werden nach der Verarbeitung freigegeben, sodass lang laufende Aufgaben deutlich weniger Arbeitsspeicher belegen (#1855).
- **Notebook** – interne Routing-Metadaten gelangen nicht mehr in Notebook-Modellaufrufe (#1861).
- **Ordnerzugriff** – eine veraltete Dialogantwort kann nicht mehr den falschen Freigabedialog schließen oder einen nicht mehr aktuellen Ordner melden (#1870).
- **Konnektoren** – während eines laufenden Speichervorgangs ist „Abbrechen“ deaktiviert, sodass die Fortsetzung der OAuth-Anmeldung geschützt bleibt (#1867).
- **Arbeitsbereich** – die Sitzungsvorschau bleibt nicht mehr unter geöffneten Aktionsmenüs sichtbar (#1852).
