## ✨ Highlights

- **CodeBuddy-Agenten-Framework.** CodeBuddy ergänzt Claude Code, OpenCode und Codex als viertes auswählbares Agenten-Framework. Es wird ohne separate Anmeldung über die Einstellungen installiert und verwaltet, verwendet die bereits konfigurierten Modellanbieter und nutzt für Fähigkeiten, Notebooks und Konnektoren dieselbe von der App verwaltete Laufzeit. (#1831, #1849)
- **Anmerkungen.** Markieren Sie Text im Konversationsverlauf, in Tool-Aktivitäten oder Dateivorschauen oder einen Punkt in einem Bild und senden Sie ihn als Kontext an den Agenten. Anmerkungen bleiben über Neustarts hinweg erhalten, werden beim Bearbeiten und erneuten Senden bewahrt und als Karten in der Konversation angezeigt. (#1815, #1821, #1826, #1837)
- **Erweiterte OpenCode-Kataloge.** OpenCode Go umfasst jetzt 21 Modelle und OpenCode Zen 40 Modelle, darunter die neuesten Familien von Claude, GPT, Grok, GLM, DeepSeek, Kimi und Qwen. Für jedes Modell stehen Angaben zu Endpunkt, Kontextfenster und Reasoning zur Verfügung. (#1807)
- **Markierungen für Konfigurationsänderungen.** Ändern sich Framework, Modell oder Reasoning-Aufwand einer Sitzung zwischen zwei Interaktionen, zeigt der Konversationsverlauf eine dezente Trennlinie mit der neuen Konfiguration. So bleibt sichtbar, in welchem Kontext spätere Antworten entstanden sind. (#1825, #1833)

## 🚀 Neue Funktionen

- **CodeBuddy-Agenten-Framework** – von der App verwaltete ACP-Laufzeit mit festgelegter Version und ohne separate Anmeldung; Sitzungssteuerung, Änderungen an Modell und Reasoning-Aufwand, Kontextkomprimierung, Bildeingabe und Nutzung pro Aufruf werden angepasst, während Fähigkeiten, Notebooks und Konnektoren weiterhin über das app-eigene Routing laufen. (#1831, #1849)
- **Text- und Bildanmerkungen** – markieren Sie Inhalte in Konversationen, Aktivitäten, Rückfragen und Dateivorschauen. Anmerkungen enthalten ihre Quelle, werden bei Bedarf eingeblendet, bleiben beim Bearbeiten und erneuten Senden erhalten und werden in Nachrichten an Agenten und Side-Chats eingebettet. (#1815, #1821, #1826, #1837)
- **Erweiterte Modellkataloge für OpenCode Go und OpenCode Zen** mit einer modellbezogenen Endpunktüberschreibung, damit Modelle mit unterschiedlichen Protokollen korrekt verbunden werden. (#1807)
- **SSH-Passwortauthentifizierung unter Windows** für Remote-Rechenhosts mit Speicherung im sicheren Windows-Speicher. (#1805)
- **Markierungen für Änderungen der Agentenkonfiguration** im Konversationsverlauf. (#1825, #1833)
- **Zeilen zum Laden von Fähigkeiten zeigen das Fähigkeitsdokument** – beim Aufklappen eines abgeschlossenen Ladevorgangs werden die Anweisungen der Fähigkeit als Markdown statt als Roh-JSON dargestellt. (#1812)
- **Kartenraster für den Spezialisten-Marktplatz** mit Filterchips für offizielle Angebote, Community-Angebote und verfügbare Aktualisierungen. (#1840)
- **Überarbeitetes Benachrichtigungscenter** – Symbole zeigen nun sowohl die Art des Ereignisses als auch, ob es noch Ihre Aufmerksamkeit erfordert; dazu kommen klarere Gelesen-/Ungelesen-Zustände und zweizeilige Vorschauen. (#1841)
- **32 zusätzliche Avatarsymbole für Spezialisten** aus Wissenschaft, Forschung, Fachrollen und Entwicklung. (#1838)

## 🔧 Verbesserungen

- Chromium-Berechtigungsanfragen aus dem Renderer werden standardmäßig abgelehnt. Dadurch verkleinert sich die Angriffsfläche bei manipuliertem Renderer-Code. (#1817)
- Dauerhaft gespeicherte Ausführungsdetails von Remote-Rechenaufträgen werden durch die sichere Speicherung des Betriebssystems geschützt. Ist dieser Schutz nicht verfügbar, erscheint eine klare Warnung. (#1818)
- IPC-Argumente für Rechenaufträge werden vor der Verwendung streng validiert. (#1820)
- Timeouts bei Konnektoranfragen werden nicht mehr erneut versucht. Eine blockierte Anfrage schlägt einmal mit einer klaren Erklärung der Frist fehl, statt dreimal jeweils 30 Sekunden zu warten. (#1829)
- Das Abbrechen einer Konnektorabfrage wirkt sofort, ohne das Abfrageintervall abzuwarten. (#1830)
- Reviewer-Sitzungen begrenzen die Größe erfasster Protokolle, damit übermäßig umfangreiche Tool-Ausgaben die App nicht blockieren. (#1824)
- Die Aufforderung, Open Science auf GitHub mit einem Stern zu markieren, berücksichtigt nun eine projektübergreifende Wartezeit und erscheint deutlich seltener. (#1813)
- Die japanischen Übersetzungen wurden hinsichtlich Terminologie und Konsistenz überarbeitet. (#1823)
- Der Startfehler in den Einstellungen verwendet nun die Standardfehleranzeige mit einer Option zum erneuten Versuch. (#1835)

## 🐛 Fehlerbehebungen

- **Remote-Rechenumgebungen** – eine Sitzung bleibt aktiv, solange ihre Remote-Aufträge noch laufen, statt zu früh als abgeschlossen zu erscheinen (#1803). Unerwartete Fehler beim Übermitteln werden außerdem mit ihrer tatsächlichen Ursache protokolliert (#1811).
- **Artefakte** – aus Aufgaben, CLI-Ausführungen und fortgesetzten Delegationen erzeugte Dateien behalten ihre Laufzeitprovenienz und lassen sich wieder zuverlässig finalisieren. (#1802, #1810)
- **Sitzungen** – leere Claude-Sitzungen, die beim Verzweigen entstanden sind, lassen sich löschen (#1806). Die Vorschaukarte einer Sitzung ist zudem an ihrer Zeile ausgerichtet und ermöglicht das direkte Umbenennen (#1843, #1845).
- **Kontextfenster** – decken Details pro Aufruf nach einem Framework- oder Modellwechsel nur einen Teil des Verlaufs ab, weist eine Meldung direkt darauf hin, statt Interaktionen unbemerkt auszublenden. (#1828)
- **Notebook** – Wettlaufsituationen in der Ausführungswarteschlange führen nicht mehr zu widersprüchlichen Zuständen wie fehlgeschlagenen Ausführungen nach erfolgreicher Laufzeitreparatur oder doppelten Unterbrechungen. (#1832)
- **Pläne** – kann eine wiederhergestellte Sitzung ihren Plan nicht lesen, zeigt sie einen sichtbaren Hinweis auf den erneuten Versuch, statt die Plankarte stillschweigend auszublenden. (#1834)
- **Dateien** – Fehler beim Entfernen von Ordnerzugriffen oder beim Laden der Artefaktabstammung werden direkt mit einer Option zum erneuten Versuch angezeigt, statt unbemerkt fehlzuschlagen. (#1842)
- **Arbeitsbereich** – Dateivorschauen schließen sich mit einem einzigen Druck auf `Cmd/Ctrl+W`. (#1804)
