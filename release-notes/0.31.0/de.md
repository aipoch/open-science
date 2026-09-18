## ✨ Highlights

- **Sitzungen in eine neue beschreibbare Kopie forken.** Eine lokale oder importierte Sitzung lässt sich mit ihrem vollständigen Forschungsverlauf forken — Konversationszweige, Notebook-Einträge, Artefaktversionen, Literatur, Annotationen und private Lesezeichen erhalten jeweils neue Identitäten. Die Quellsitzung wird nie verändert, und importierte Sitzungen bleiben schreibgeschützt. (#2719)
- **Ein Produktname: Open-Science.** Die App stellt sich in der Oberfläche, der CLI und der Paketierung durchgängig als Open-Science dar. Bestehende Installationen behalten ihre bisherigen Namen und Speicherorte — Forschungsdaten, Zugangsdaten und Einstellungen bleiben unangetastet. (#2567)
- **Sitzungspläne überleben die Kontextrekonstruktion.** Nachdem der Agent seinen Kontext neu aufgebaut hat, wird der aktive Sitzungsplan mit Identität, Revision und ausstehenden Zulassungen wiederhergestellt, und die Plan-Werkzeuge bleiben im Gespräch verfügbar. (#2661)
- **Anbieter-Verbindungen werden geprüft, bevor sie gespeichert werden.** Anbieter-Änderungen werden getestet und nur bei erfolgreicher Verbindung gesichert; wird ein gespeicherter Anbieter zur Laufzeit abgelehnt, aktualisiert sich seine Verfügbarkeit, statt still zu scheitern. (#2746)

## 🚀 Neue Funktionen

- Eine Sitzungsinformationskarte in der Kopfzeile des Gesprächs zeigt die Nummer, den Titel, die Beschreibung, die Quellsitzung, die Zeitstempel sowie die Zahlen der Nachrichten und Artefakte der Sitzung, mit einem Anhefte-Steuerelement, das lange Titel kompakt hält. (#2764)
- Anmeldeinformations-Aufforderungen für OpenAlex und NCBI verlinken direkt zu den offiziellen API-Key-Seiten. (#2761)
- gnomAD-Variantenabfragen können optional populationsweite Allelfrequenzen und Genotypzahlen einbeziehen. (#2741)
- Sitzungen, die in einen neuen Chat verzweigt wurden, zeigen eine Trennlinie „fortgesetzt von", die an ihren Quellzug verankert ist. (#2747)
- Die Einstellungen vereinheitlichen Panel-Titel, Abschnittsüberschriften, Speicher-Rückmeldungen und die Ausrichtung der Steuerelemente über alle Panels hinweg. (#2739)

## ⚠️ Inkompatible Änderungen

- Erweiterte STRING-Netzwerke melden jetzt den vollständigen zurückgegebenen Graphen in `nodes`: hinzugefügte Nachbarn tragen `is_query=false`, und `n_nodes` entspricht nicht mehr der Anzahl der Eingangsproteine. Notebook-Skripte, die `nodes` als Eingabezuordnung behandelten, müssen nach `is_query` filtern. (#2737)

## 🐛 Fehlerbehebungen

- **Notebook und Berechnung** – Windows-R läuft im Standardmodus ohne Protected-Mode-Einrichtung (#2708); Ausführungsprotokolle von Artefakten zeigen keine falschen Lücken in der Umgebungs-Evidenz mehr (#2720); Lock-Diagnosen pro Lauf bleiben für Reproduzierbarkeitsprüfungen erhalten (#2738).
- **Agent-Laufzeit** – Codex-Gespräche bleiben beim Wechsel der Reasoning-Stufe nutzbar (#2724); feststeckende Stopp-, Fortsetzungs- und eingereihte Folgebefehle gehen zuverlässig auf (#2745); abgebrochene Netzwerk-Zulassungen werden ausgemustert, statt als tote Karten stehen zu bleiben (#2744).
- **Sitzungen und Berechtigungen** – der Schrittfortschritt des Sitzungsplans bleibt sichtbar, während Berechtigungsaktualisierungen eintreffen (#2759); der Abschluss von Berechtigungen wird mit gleichzeitigen Zügen abgeglichen, und doppelte Sende-Wiederholungen hängen keine nicht zugestellten Nachrichten mehr an (#2743); Berechtigungsänderungen sind vor der Wiedergabe der Zweig-Historie erlaubt (#2736); Fork-Trennlinien verankern sich am kopierten Zug (#2733); unveröffentlichte Artefakt-Köpfe überleben das Forken, ohne den Start zu blockieren (#2730).
- **Konnektoren** – sekundäre UniProt-Zugriffsnummern lösen sich zu ihren aktuellen primären Einträgen auf (#2762); Ensembl löst FlyBase-, WormBase- und Hefe-Bezeichner auf, bevor auf den Symbol-Fallback zurückgegriffen wird, und bewahrt Fehler bei Sequenzanfragen (#2715, #2752); cBioPortal-Mutationsfrequenzen zählen genprofilierte Proben (#2721); Eignungsfilter für klinische Studien beachten Alters- und Geschlechtsgrenzen (#2734); die Molekül-Darstellung bewahrt Molfile-Header und weist leere Strukturen zurück (#2751); Zählungen schwerer Atome in Molekülen schließen explizite Wasserstoffatome und Wasserstoffisotope aus (#2766).
- **Oberfläche und Speicher** – das aktive benutzerdefinierte Modell wird synchronisiert, wenn sein Anbieter gespeichert wird (#2712); das Öffnen von Anhängen bewahrt übergeordnete Dialoge (#2735); das Verwerfen von Dialogen blinkt nicht mehr und setzt Inhalte nicht zurück (#2723, #2742); die Folge-Absicht des Transkripts übersteht Layoutänderungen (#2732); Speicherbereinigung und lokale Importe sind gegen symbolisch verknüpfte Verzeichnisse und neu geschriebene Quelldateien abgesichert (#2711); Spezialisten-Pakete richten Import-Vorgaben und Export-Steuerungen aneinander aus (#2756); schreibgeschützte OpenCode-Fähigkeiten werden nach der Delegation aufgeräumt (#2716).
