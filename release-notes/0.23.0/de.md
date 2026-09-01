## ✨ Highlights

- **Fachliteratur gemeinsam mit dem Agenten lesen.** Verknüpfen Sie bis zu drei PDFs als Lesekontext mit einer Sitzung. Der Agent kann die aktuelle Seite lesen, das gesamte Dokument durchgehen und die verknüpften PDFs durchsuchen. Markieren Sie Text oder einen Bereich in der erweiterten PDF-Vorschau, um ihn als Nachweis zu senden und später mit einem Klick im Quelldokument wiederzufinden. (#1791)
- **Notebook-Variablen stets im Blick.** Das gemeinsame Terminal schlägt während der Eingabe Variablen des aktiven Kernels vor. In breiten Vorschauen wird der Live-Bereich „Variablen“ neben den Zellen und dem Terminal angedockt, statt diese zu ersetzen. (#1919, #1918)
- **Tencent-Abonnementtarife.** Tencent Coding Plan für das chinesische Festland und Token Plan für internationale Nutzer ergänzen den nutzungsbasierten Anbieter TokenHub. (#1901)
- **Sicherere lokale Daten.** Das Verschieben des Datenspeicherorts erfolgt atomar und bewahrt Artefaktmetadaten, Upload-Entwürfe und die Identität von Artefaktversionen. Für den Support freigegebene Diagnoseberichte werden standardmäßig bereinigt. (#1882, #1904, #1905, #1907)

## 🚀 Neue Funktionen

- **PDF-Lesekontext und Nachweise** – bis zu drei mehrseitige PDFs lassen sich über eindeutige Aktionen mit einer Sitzung verknüpfen und wieder lösen. Der Agent liest die aktuelle Seite, verarbeitet das gesamte Dokument in Abschnitten oder durchsucht alle verknüpften PDFs. Der gelesene Stand bleibt bei Nachrichtenwarteschlangen, Wiederholungen, Branches und Fortsetzungen stabil. Die erweiterte PDF-Vorschau bietet Text- und Bereichsauswahl, Gliederung und Miniaturansichten, Dokumentsuche, Seitennavigation und Zoomsteuerung. Auswahlen werden zu Nachweisanmerkungen, die sich per Klick im Quelldokument anzeigen lassen. (#1791)
- **Vorschläge für Live-Kernel-Variablen** – das Notebook-Terminal schlägt passende Variablennamen aus dem laufenden Python- oder R-Kernel samt Typ vor. Die Vorschläge lassen sich per Tastatur bedienen und funktionieren zuverlässig mit Eingabemethoden-Editoren. (#1919)
- **Angedockter Variablenbereich in breiten Vorschauen** – bei ausreichender Breite werden Live-Variablen in einer Seitenspalte angezeigt, während Zellen und Terminal sichtbar bleiben. Schmale Vorschauen verwenden weiterhin die fokussierte Variablenansicht; sobald wieder genügend Platz vorhanden ist, kehrt der angedockte Bereich automatisch zurück. (#1918)
- **Tencent Coding Plan und Token Plan** – eigene Abonnementanbieter für das chinesische Festland und internationale Endpunkte mit jeweils kuratierter Modellauswahl, zusätzlich zum bestehenden nutzungsbasierten Tencent TokenHub. (#1901)

## 🔧 Verbesserungen

- Notebook-Caches für Arbeitspakete liegen nun unter dem konfigurierten Datenspeicherort. Beim Verschieben des Speichers werden Paket- und Arbeitslast-Caches mitgenommen, statt auf dem Systemlaufwerk zurückzubleiben. (#1710)
- Für den Support freigegebene Diagnoseberichte werden standardmäßig bereinigt. Lokale Diagnosen bleiben begrenzt, damit sie bei langen Forschungssitzungen nicht unbegrenzt wachsen. (#1907, #1909)
- Das Beenden während aktiver Arbeit wird erklärt, statt kommentarlos blockiert zu werden. Dazu gehört eine Warnung vor dem Unterbrechen eines laufenden Reviewers. Benachrichtigungen sind lokalisiert, berücksichtigen die Systemeinstellung für private Vorschauen und ignorieren veraltete Klicks. (#1910, #1912, #1913, #1914)

## 🐛 Fehlerbehebungen

- **Speicher und Migration** – beim Verschieben des Datenspeicherorts bleiben keine teilweise kopierten Daten zurück; Artefaktmetadaten, Upload-Entwürfe und die Identität von Artefaktversionen bleiben erhalten (#1882, #1885, #1893, #1904, #1905). Beschädigte Sitzungsdateien werden angezeigt statt kommentarlos übersprungen, und die Wiederherstellung nach Löschvorgängen bleibt auf tatsächlich gelöschte Daten beschränkt (#1899). Projekte melden noch ausstehende Bereinigungen nach dem Löschen (#1896), und verknüpfte Systempfade werden bei der Migration abgelehnt (#1894).
- **Remote-Zugriff** – autorisierte Browsersitzungen sind voneinander isoliert, der Autorisierungslebenszyklus wird durchgängig eingehalten und Remote-Anfragen folgen ihren Verträgen. (#1915, #1917, #1897)
- **Anmeldeinformationen und Anbieter** – die Wiederherstellung von Anmeldeinformationen erreicht Sie direkt im Eingabebereich (#1883); nicht entschlüsselbare Anmeldeinformationen werden nicht mehr als funktionsfähig gemeldet (#1886); unsichere Linux-Geheimnisspeicher werden abgelehnt statt unbemerkt verwendet (#1887); der Status des sicheren Speichers wird selbstständig aktualisiert (#1888); der Anbieterkatalog übernimmt keine veralteten Schreibvorgänge mehr (#1890).
- **Rechenumgebungen, Notebook und Uploads** – Ergebnisse automatischer Analysen bleiben über Neustarts erhalten (#1916); SSH-Host-Aliasse und Scratch-Pfade werden validiert (#1920); der R-Kernel übersteht wiederholte Abbrüche (#1892); Anfragen zum Abschluss einer Sitzung werden validiert (#1908).
- **Dienst und Plattform** – der lokale Dienst lehnt fehlerhaft codierte URLs ab (#1889); die Plattformbehandlung für Updates und CLI wurde korrigiert (#1895) und der Lebenszyklus des Installationsprogramms abgesichert (#1898); Tool-Berechtigungen von Spezialisten werden für Konnektoren durchgesetzt (#1926); App-Oberflächen sind bei Dokumentzugriffen voneinander isoliert (#1924).
