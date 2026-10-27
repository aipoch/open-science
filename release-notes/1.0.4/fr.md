## ✨ Highlights

- **Les téléchargements sont nettement plus petits.** Les charges utiles d'exécution de la CLI et du bureau sont réduites en élaguant les composants générés inutilisés, en regroupant le worker de traduction contre son exécution compacte, en fournissant un gestionnaire d'environnement unique groupé et en supprimant les distributions alternatives inutilisées — sans retirer les fichiers d'exécution actifs ni les diagnostics. (#3863, #3867)
- **La CLI autonome parle désormais MCP.** Les outils de recherche sont exposés via un serveur MCP local, afin que les clients MCP externes puissent découvrir et invoquer directement les capacités de recherche de la CLI. (#3862)
- **Les longues conversations restent lisibles.** Une fois un tour réglé, les messages intermédiaires se replient hors du chemin pendant l'exécution, tandis que le travail en cours, en attente et interrompu reste visible ; les groupes d'outils se replient en résumés, et la recherche, les annotations et la recherche native révèlent toujours le contenu masqué quand vous en avez besoin. (#3868, #3866)
- **La bibliothèque Literature gagne des vérifications d'intégrité.** Les références dotées d'un DOI peuvent être vérifiées à la demande auprès de Crossref pour les rétractions et corrections, avec les résultats et les heures de vérification enregistrés sur la référence. (#3870)

## 🚀 New Features

- La CLI autonome expose ses outils de recherche via un serveur MCP local pour les clients d'outils externes. (#3862)
- Les cartes de questions prennent en charge des actions de saut structurées avec des contrôles fixes et prévisibles. (#3813)
- Les références de la bibliothèque Literature prennent en charge des vérifications explicites de rétraction et de correction par référence via Crossref, lancées manuellement et uniquement pour les entrées avec un DOI valide. (#3870)
- Les artifacts peuvent désormais être importés depuis les dossiers que vous avez autorisés, en utilisant le pipeline d'artifacts immuables existant. (#3882)
- Le workflow d'import GitHub Skills peut enregistrer des référentiels pour les réutiliser. (#3878)
- Les transcriptions de conversation replient les messages intermédiaires une fois le tour réglé, avec un basculement au clavier et une révélation complète par la recherche, les annotations et la recherche native. (#3868)
- L'activité des outils dans la transcription se replie en groupes, les outils en cours étant résumés pendant leur fonctionnement. (#3866)

## 🔧 Improvements

- Les téléchargements de la CLI et du bureau sont plus petits sur toutes les plateformes grâce à des charges utiles d'exécution élaguées, un worker de traduction groupé compact et un gestionnaire d'environnement unique groupé. (#3863)

## 🐛 Bug Fixes

- L'exécution standard des notebooks sous Windows est restaurée. (#3872)
- Le runtime tokenizer lite est à nouveau conservé dans les builds packagés. (#3867)
- L'export de paquet de session n'attend plus à l'étape d'emplacement de sauvegarde après une sélection effectuée. (#3874)
- La boîte de dialogue d'accès aux dossiers des paramètres et son étape de nettoyage ne se font plus concurrence. (#3877)
- Les sélecteurs ask-user ne bouclent plus après un échec de continuation. (#3879)
- Le replay présente les résultats automatiques comme des événements système plutôt que des messages ambigus. (#3881)
