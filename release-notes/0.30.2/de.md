## ✨ Highlights

- **Windows-R ist wieder verlässlich.** Über conda verwaltetes R startet zuverlässig unter Windows, der Interpreter wird nach dem Aufbau der Umgebung wieder aufgelöst, die verifizierte Kernel-Wiederherstellung bewahrt Ausführungen, und Prüfungen versiegelter Rezepte stellen verifizierte pip-Einstiegspunkte unter Windows wieder her. (#2630, #2645, #2653, #2679)
- **Notebook-Züge werden korrekt erneut abgespielt.** Eingaben aus demselben Zug und Importe der Standardbibliothek werden bei der Wiederholung wiederhergestellt, sodass ein erneuter Lauf exakt die Eingaben sieht, die der ursprüngliche Lauf gesehen hat. (#2706)
- **Korrekturen des Prüfers behalten ihren Kontext.** Verknüpfte Rückmeldungs-Threads verlieren den Korrekturkontext nicht mehr zwischen den Runden, und die automatische Prüfung übersteht den Start eines neuen Gesprächs. (#2682, #2625)
- **Sauberere Evidenz aus Literatur und Konnektoren.** PubMed-Importe trennen Autorennachnamen von Initialen (und lesen Suffixe wie „Jr." nicht mehr als Initialen), über Crossref-Aktualisierungen sichtbar gemachte Retraktionsketten werden geprüft, und Ensembl, VEP, Reactome, OLS, CellGuide, UCSC und gnomAD verhalten sich präzise. (#2675, #2677, #2693, #2703, #2696, #2687, #2664, #2663, #2634)

## 🔧 Verbesserungen

- DeepSeek V4.1 Flash kommt zum Modellkatalog hinzu, ältere Sitzungsmodelle bleiben über die Aktualisierung hinweg erhalten (#2660), und die Modellpalette von Volcengine Ark wird aufgefrischt (#2673).
- Auswahlindikatoren von Registerkarten animieren sich flüssig. (#2638)
- Literatur-Werkzeugkarten sind vereinheitlicht und Literaturdetails sind erweitert. (#2670)

## 🐛 Fehlerbehebungen

- **Notebook und Berechnung** – über conda verwaltetes R startet unter Windows wieder, und Sandbox-Fehler werden nachvollziehbar (#2630); die ausführbare R-Datei wird nach dem Aufbau der Umgebung aufgelöst (#2645); Ausführung und verifizierte Kernel-Wiederherstellung bleiben erhalten (#2653); Eingaben aus demselben Zug und Importe der Standardbibliothek spielen sich korrekt erneut ab (#2706); verifizierte pip-Einstiegspunkte unter Windows werden für Reproduzierbarkeitsprüfungen wiederhergestellt (#2679); eingereihte CLI-Gesprächsmomentaufnahmen werden abgeglichen (#2676); beim passiven Einlesen von Gesprächen erfolgen keine Schreibvorgänge (#2640).
- **Literatur** – PubMed-Autorennachnamen und Initialen werden getrennt (#2675), und Autoren-Suffixe werden nicht mehr als Initialen behandelt (#2677); Retraktionsbeziehungen vom Typ „updated by" aus Crossref-Aktualisierungen werden geprüft (#2693).
- **Konnektoren** – Ensembl-Abfragen melden die aufgelöste Spezies (#2703); VEP-Regionsabfragen werden auf den Vorwärtsstrang normalisiert (#2696); die angeforderte Reactome-Spezies wird berücksichtigt und validiert (#2687); OLS-Fehler bleiben erhalten, und die Paginierung von Relationen wird validiert (#2664); Fehler beim Abrufen von CellGuide-Daten werden korrekt angezeigt (#2663); UCSC-Bereichsgrenzen werden validiert und gnomAD-Limits verschärft (#2634).
- **Sitzungen und Nebengespräche** – Nebengespräche behalten ihren Mount in der Anwendung (#2680) und warten für die Zulassung nicht mehr auf die Bereitschaft des Hauptgesprächs (#2668); delegierte OpenCode-Unteragenten laufen in isolierten Laufzeiten (#2652).
- **Fähigkeiten und Marktplatz** – an Spezialisten gebundene Laufzeit-Fähigkeiten bereiten sich korrekt vor (#2698); der Marktplatz zeigt seine Quelle an, wenn Autoren fehlen (#2672); bereitgestellte OpenCode-Fähigkeitsreferenzen sind lesbar (#2651).
- **Berechtigungen und Einstellungen** – die Freigabe der nativen Websuche wird für das Gespräch gemerkt (#2646); die Einstellungen bleiben geöffnet, wenn die mobile Navigation geschlossen wird (#2658); die Go-Sitzungsidentität wird in Anbieter-Verbindungstests einbezogen (#2662); die Bilddetailstufe „original" wird in der Responses-Brücke normalisiert (#2650); „Rückgängig" bleibt über dem Einstellungsfenster (#2641); kontextbezogene Inline-Layouts von Nachrichten werden wiederhergestellt (#2674).
