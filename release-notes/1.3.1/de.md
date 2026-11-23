## ✨ Highlights

- **Websuche und Seitenlesen für den integrierten Agenten.** Der Open-Science Agent kann im Web suchen und öffentliche Seiten lesen. Suchfreigaben zeigen die Anfrage und ihre Filter in einer übersichtlichen Karte, und die zitierten Quellen bleiben über Neustarts, Zweige und Forschungspakete hinweg beim Gespräch. (#4448, #4471)
- **Interaktiver Zitationsgraph.** Die Referenzen eines Artikels und die ihn zitierenden Artikel erscheinen als Graph, den Sie erkunden können. Zentrieren Sie den Graphen auf einen beliebigen verwandten Artikel neu, filtern Sie nach Richtung und kehren Sie zum ursprünglichen Artikel zurück. (#4418, #4467)
- **Ihren Agenten über MCP nutzen, ohne die App zu öffnen.** Wenn sich ein externer Agent über MCP mit Open-Science verbindet, startet der Hintergrunddienst von selbst. Die Einrichtungsanleitung deckt jetzt mehr als 30 Agenten und Clients ab. (#4470, #4464)
- **Lab-Modelle und Organisationsfälle.** Melden Sie sich mit einem Lab-Konto an, um die Modelle zu nutzen, die Ihre Organisation zuweist, und um Forschungsfälle zu durchsuchen, zu importieren oder mit Ihrem Team zu teilen. (#4447)
- **Aktuelle Modelllisten und klarere Anbieterfehler.** Aktualisieren Sie die Modellliste eines Anbieters in den Einstellungen. Wenn eine Anbieteranfrage fehlschlägt, nennt das Gespräch die Ursache und bietet den passenden nächsten Schritt an. (#4415)

## ⚠️ Scope & Safety

- **Das Update von 1.3.0 erfordert möglicherweise eine manuelle Installation.** Der Updater von 1.3.0 kann einen der eigenen Hintergrundprozesse der App für ein anderes Programm halten und die Installation verweigern. Diese Version kann den bereits in 1.3.0 laufenden Updater nicht ändern. Meldet das Update, dass ein anderer Prozess die Installation verwendet, beenden Sie Open-Science und seinen Hintergrunddienst vollständig und installieren Sie das heruntergeladene Paket anschließend manuell. Ihre Profile und Forschungsdaten bleiben unverändert. Updates, die von 1.3.1 ausgehen, sind nicht betroffen. Siehe das [Register bekannter Einschränkungen](https://github.com/aipoch/open-science/blob/v1.3.1/docs/known-limitations.md). (#4454)
- **Websuche und Seitenlesen kontaktieren externe Dienste.** Suchanfragen gehen ohne Konto an Exa, einen Suchdienst eines Drittanbieters. Das Lesen einer Seite kontaktiert die Website dieser Seite. Beide Werkzeuge folgen Ihrem Berechtigungsmodus, und das Abbrechen einer Anfrage kann bereits Gesendetes nicht zurückholen. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.1/docs/security.md#data-recipients). (#4448)
- **Die Lab-Anmeldung ändert, wohin Anfragen gehen.** Mit einem Lab-Konto laufen Anfragen an Lab-Modelle über den Lab-Server, bei dem Sie sich anmelden. Das Teilen eines Falls lädt das Forschungspaket dieser Sitzung für Ihre Organisation auf diesen Server hoch. Prüfen Sie das Paket, bevor Sie es teilen, und prüfen Sie einen Organisationsfall, bevor Sie ihn importieren. (#4447)
- **Das Verbinden eines Agenten hält den Dienst am Laufen.** Das Verbinden eines externen Agenten startet den Hintergrunddienst, und der Dienst läuft weiter, nachdem sich der Agent getrennt hat. Beenden Sie ihn mit `open-science stop`, wenn Sie ihn nicht mehr benötigen. (#4470)

## 🚀 New Features

- Der integrierte Open-Science Agent kann im Web suchen und öffentliche Seiten lesen. Er zitiert seine Quellen, und diese Quellen bleiben offline, über Zweige hinweg und in Forschungspaketen, die das zulassen, verfügbar. (#4448)
- Freigaben für die Websuche zeigen Anfrage, Zeitraum, Ergebnisgrenze und Domainfilter in einer übersichtlichen Karte. (#4471)
- Das Zitationsnetz eines Artikels als interaktiven Graphen erkunden: Alle, Referenzen oder Zitiert von wählen, Pfeilen folgen, die die Zitationsrichtung zeigen, auf einen beliebigen verwandten Artikel neu zentrieren und zum ursprünglichen Artikel zurückkehren. (#4418)
- Über MCP verbundene externe Agenten starten beim Verbinden den Open-Science-Dienst für Ihr Profil oder verwenden ihn wieder, sodass Sie die App nicht mehr zuerst öffnen müssen. (#4470)
- README und CLI-Anleitung enthalten einen Schnellstart für externe Agenten, mit Einrichtungsoptionen für mehr als 30 Agenten und lokale Clients sowie einem ersten Aufruf, der die Verbindung bestätigt. (#4464)
- Mit einem Lab-Konto anmelden, um die Modelle Ihrer Organisation zu nutzen und deren Verbrauch zu verfolgen. Die Forschungsfälle Ihrer Organisation durchsuchen, verifizierte Fälle importieren und eine Sitzung hochladen, um sie per Freigabecode zu teilen. (#4447)
- Die Modellliste eines Anbieters in den Einstellungen aktualisieren. Eine fehlgeschlagene Aktualisierung behält die bisherige Liste. (#4415)
- Bilddienste können vor dem Speichern eine optionale Testerzeugung ausführen. Das Speichern eines neuen Bilddienstes wählt außerdem dessen erstes Modell aus, wenn noch kein Standardmodell festgelegt ist. (#4455)

## 🔧 Improvements

- Anbieterfehler nennen ihre Ursache im Gespräch, darunter Authentifizierung, Kontingent, Ratenbegrenzungen, nicht verfügbare Modelle, Verbindungsabbruch, unterbrochene Antworten und Kontextgrenzen, und bieten die passende Wiederherstellungsaktion an. (#4415)
- Notebook-Läufe prüfen vor dem Start den verfügbaren Arbeitsspeicher. Ist der Arbeitsspeicher des Systems knapp, wird ein Lauf nicht gestartet, und Sie können ihn selbst erneut versuchen. Unter Compute können Sie eine Sitzung auswählen und ihre Notebook-Ressourcen freigeben, während laufende Arbeit geschützt bleibt. (#4374)
- Die Projektübersicht erscheint beim Start früher. Sitzungsdetails werden geladen, wenn Sie eine Sitzung öffnen, statt alle auf einmal. (#4434)
- Fehlt der gespeicherte Forschungsordner, zeigt der Wiederherstellungsdialog beim Start den Pfad dieses Ordners und bittet Sie, das Laufwerk wieder zu verbinden. (#4472)
- Die Ersteinrichtung unter Windows bleibt nicht mehr beim optionalen WSL-Schritt stehen. Sie können WSL2 Bash später unter Einstellungen → Laufzeiten einrichten. (#4463)
- Fehler bei der Windows-Installation zeigen ihre Diagnosedaten schneller an. (#4457)
- Die Pfeile des Zitationsgraphen treffen ihre Zielartikel, und der Hinweis auf Elemente außerhalb des sichtbaren Bereichs nimmt auf kleinen Bildschirmen weniger Platz ein. (#4467)

## 🐛 Bug Fixes

- In-App-Updates halten den eigenen Hintergrund-Protokollprozess der App nicht mehr für ein anderes Programm, das die Installation blockiert. (#4454)
- Deinstallation und Update unter Windows schlagen nicht mehr fehl, wenn die Einstellungsdatei groß ist. (#4469)
- Nach einer erneuten Verbindung behalten Sitzungen nicht gesendete Entwürfe, laden lange verzweigte Verläufe und nehmen Antworten auf Fragen an, die nach einem Absturz wiederhergestellt wurden. Das Umbenennen oder Anheften einer Sitzung überschreibt keine neueren Änderungen mehr. (#4460)
- Eine Sitzung, deren Details nicht geladen werden konnten, wiederholt diesen Ladevorgang nicht mehr endlos. (#4452)
- Neue Agentensitzungen zeigen beim Start keine wiederholten Literaturwarnungen mehr. (#4462)
- Das Löschen einer importierten Sitzung unter Windows entfernt ihre Dateien und Datensätze vollständig. (#4459)
- Eine eigenständig geöffnete Notebook-Sitzung lädt den bisherigen Gesprächsverlauf des Agenten, statt ohne ihn zu starten. (#4461)

## 🙏 Danksagungen

- Danke an [@wen2zhou](https://github.com/wen2zhou) für die integrierte Websuche und das Seitenlesen ([#4448](https://github.com/aipoch/open-science/pull/4448)).
- Danke an [@nasus2002](https://github.com/nasus2002) für den interaktiven Zitationsgraphen ([#4418](https://github.com/aipoch/open-science/pull/4418), [#4467](https://github.com/aipoch/open-science/pull/4467)).
- Danke an [@ShuangChenyue](https://github.com/ShuangChenyue) für Lab-Modelle und das Teilen von Organisationsfällen ([#4447](https://github.com/aipoch/open-science/pull/4447)).
- Danke an [@liguohhh](https://github.com/liguohhh) für die Aktualisierung von Modelllisten und klarere Anbieterfehler ([#4415](https://github.com/aipoch/open-science/pull/4415)).
- Danke an [@guch96](https://github.com/guch96) für die Arbeitsspeicherprüfungen und die Ressourcenfreigabe im Notebook ([#4374](https://github.com/aipoch/open-science/pull/4374)), und an [@liyeshunag](https://github.com/liyeshunag) für die Korrektur der Literaturwarnungen in neuen Sitzungen ([#4462](https://github.com/aipoch/open-science/pull/4462)).
