## ✨ Points forts

- **Collections de littérature intelligentes.** Une collection peut désormais cribler ses références à l’aune d’une description dotée de critères d’inclusion et d’exclusion explicites, en les répartissant entre Inclus, À examiner, Exclu et Non évalué — les décisions de l’IA et les décisions manuelles sont distinguées, les références individuelles ou sélectionnées peuvent être évaluées, et les preuves PDF facultatives, les aperçus de brouillons, l’annulation, les nouvelles tentatives explicites et les mises à jour automatiques sur activation permettent de garder les campagnes de criblage de grande envergure sous contrôle. (#2897)
- **Les paquets de recherche intègrent les métadonnées RO-Crate.** Les paquets `.science` nouvellement exportés décrivent leur instantané final avec des métadonnées RO-Crate 1.1, en réutilisant certaines charges utiles immuables sélectionnées et en reconstruisant les références après une réexportation. Les paquets existants restent lisibles sans migration. (#2869)
- **Trois nouveaux connecteurs.** La découverte d’enregistrements publics Zenodo recherche des enregistrements et récupère les métadonnées et les inventaires de fichiers sans authentification (#2868) ; les outils GDC listent les projets et les cas de génomique du cancer, recherchent des métadonnées de fichiers et génèrent des manifestes sans impliquer d’autorisation de téléchargement (#2896) ; le mappage par lots d’identifiants UniProt convertit jusqu’à 100 000 identifiants entre bases de données, avec un signalement explicite des résultats non appariés. (#2881)
- **Contrôles d’accès aux ressources par agent.** Les paramètres réunissent au même endroit l’accès de l’agent principal et des spécialistes aux compétences et aux connecteurs, avec des indicateurs d’utilisation sous chaque ressource et un point d’ajustement unique. (#2835)

## 🚀 Nouveautés

- Collections de littérature intelligentes : criblage piloté par une description avec critères d’inclusion/exclusion, états Inclus / À examiner / Exclu / Non évalué, étiquettes distinguant les décisions de l’IA et les décisions manuelles, évaluation individuelle ou par lot, et mises à jour automatiques sur activation. (#2897)
- Export des diagnostics de session : l’en-tête de session et le menu de la barre latérale peuvent regrouper les sources de diagnostics choisies dans une archive locale unique, si bien que signaler une conversation en échec ne revient plus à chercher des fichiers. (#2867)
- Les modèles Xiaomi MiMo v2.6 rejoignent le sélecteur de fournisseurs avec des fenêtres de contexte d’un million de jetons ; `mimo-v2.6-pro` devient la valeur par défaut des nouvelles configurations tandis que les modèles v2.5 sont préservés pour les configurations existantes. (#2894)
- Grok 4.7 rejoint le catalogue xAI comme nouvelle valeur par défaut avec une fenêtre de contexte de 500 000 jetons et l’entrée d’images ; les identifiants de modèles précédents restent disponibles. (#2887)
- Des modèles de dernière génération rafraîchissent les catalogues des fournisseurs Zen et Go, avec les caractéristiques de protocole, de contexte, de vision et d’effort de raisonnement vérifiées à partir de la documentation des passerelles. (#2910)

## 🔧 Améliorations

- La diffusion en continu reste réactive sous charge : l’estimation des jetons et les files de diffusion sont bornées, les flux d’assistants propres à chaque framework sont normalisés et les fragments de réflexion sont abandonnés avant d’atteindre le moteur de rendu. (#2903, #2895, #2883)
- Les métadonnées RO-Crate des paquets de session sont renforcées : les noms de fichiers alternatifs et les types MIME sont préservés pour les charges utiles partagées, et les tailles déclarées contradictoires sont rejetées avant la construction du graphe de métadonnées. (#2880)

## ⚠️ Changements majeurs

- Les paquets de recherche `.science` nouvellement exportés incluent des métadonnées RO-Crate décrivant l’instantané final exporté. La lecture des paquets nouvellement exportés exige un lecteur prenant en charge la capacité ro-crate ; les paquets existants restent lisibles sans migration, et les schémas de la base de données native et des preuves restent inchangés. (#2869)

## 🐛 Corrections

- **Environnement d’exécution des agents** — les versions de Claude CLI non prises en charge sont bloquées par un signal de disponibilité clair au lieu d’une erreur de création de session opaque (#2901) ; les erreurs d’adoption de la solution de repli survivent à une reprise en échec (#2906) ; les exécutions actives périmées sont récupérées avant l’ajout de nouveaux messages (#2877).
- **Paquets de recherche** — les faux positifs de blocage d’export d’identifiants ne se déclenchent plus pour des paquets ordinaires (#2904).
- **Notebook** — les avis de récupération d’environnement et d’arrière-plan peuvent être fermés, si bien qu’un volet bloqué ou une notification persistante bloquée ne requiert plus de contournement (#2905, #2870) ; les sondes d’inventaire R sous Windows s’exécutent comme des scripts d’une seule ligne (#2899) ; les effets auxiliaires sont conservés au titre de la lignée des fichiers (#2834).
- **Plateforme** — l’outil de réinitialisation des paquets Windows efface les attributs en lecture seule de l’arborescence (#2902) ; les paquets Linux embarquent le moteur de requêtes Fedora pour que les systèmes à base de Fedora démarrent de manière fiable (#2886).
- **Interface et connecteurs** — les commandes de diagnostics tolèrent un démarrage lent et la boîte de dialogue d’export est affinée (#2893, #2888) ; les surlignages de recherche sont rétablis et les interactions PDF stabilisées (#2912) ; les paramètres d’accès aux ressources ne débordent plus horizontalement (#2879) ; la carte de récupération des spécialistes reste au-dessus du dock de la zone de rédaction (#2873) ; les catalogues MCP du pont Codex s’alignent sur le registre actuel (#2885) ; les pistes de conservation de la souris UCSC utilisent la valeur par défaut correcte (#2861).
