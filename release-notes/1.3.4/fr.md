## ✨ Highlights

- **Regardez l'Agent intégré à l'œuvre.** Les projets peuvent activer le traçage de l'Agent, qui exporte des spans corrélées pour les tours, les requêtes de modèle et les exécutions d'outils vers un récepteur OTLP/HTTP que vous hébergez — les collecteurs génériques et Langfuse sont pris en charge — avec un niveau de détail de capture que vous contrôlez. (#4514)
- **Mises à jour Windows débloquées et plus petites.** Une mise à jour dans l'application ne reste plus bloquée pendant que l'Agent intégré tourne : le programme de mise à jour reconnaît désormais les propres processus Agent de l'application au lieu d'échouer de façon bloquante. Les mises à jour stables sous Windows s'appliquent aussi à nouveau sous forme de deltas d'installation compacts — v1.3.3 était retombée sur l'installateur complet. (#4602, #4606, #4611, #4605)
- **Les longs historiques Notebook restent rapides.** Démarrer et terminer des exécutions, sélectionner des résultats et ouvrir des aperçus ne relisent plus l'historique en entier, et les transitions d'exécution admissibles sont regroupées en points de contrôle durables. (#4615, #4617)
- **Des relevés mémoire fiables.** Sous macOS, le résumé de l'appareil de calcul correspond désormais à Activity Monitor en excluant la mémoire en cache ; sous Windows, la mémoire validée par rapport à sa limite est affichée à côté de la mémoire physique. (#4599, #4600)

## ⚠️ Portée et sécurité

- **Le traçage de l'Agent envoie des données vers un récepteur que vous configurez.** Le traçage de projet est désactivé par défaut et ne démarre que lorsqu'un projet l'active ; pour une exécution CLI unique, le drapeau `--otel-traces` (ou `otelTraces: true` dans le SDK) est une option explicite par exécution qui ne requiert pas le commutateur de projet. Dans les deux cas, les spans — la structure des tours, les requêtes de modèle et les exécutions d'outils selon le niveau de détail choisi — ne vont qu'au point de terminaison OTLP/HTTP défini dans la configuration de lancement de l'application, jamais vers un service exploité par l'application. Choisissez un récepteur que vous contrôlez et examinez les commutateurs de capture avant d'activer le traçage sur des machines partagées. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.4/docs/security.md#data-recipients). (#4514)

## 🚀 New Features

- Les projets gagnent un commutateur de **traçage de l'Agent** en opt-in : lorsqu'il est activé et qu'un récepteur est configuré, l'Agent intégré exporte des spans JSON OTLP/HTTP corrélées pour les tours, les requêtes de modèle et les exécutions d'outils MCP vers des collecteurs génériques ou Langfuse. Quatre commutateurs de détail règlent ce qui est capturé, et un commutateur local d'état d'envoi rapporte la bonne santé de la livraison. (#4514)
- Les connexions CodeBuddy découvrent les efforts de raisonnement pris en charge par chaque modèle lors de la connexion et du rafraîchissement du catalogue ; le sélecteur d'effort ne propose alors que les niveaux que le modèle sélectionné prend réellement en charge. (#4619)
- Le catalogue de modèles Zhipu liste désormais GLM-5.4, disponible directement sur les connexions Zhipu. (#4637)

## 🔧 Improvements

- Les longs historiques Notebook coûtent moins cher : une vue d'historique bornée et validée remplace les lectures intégrales répétées lors du démarrage ou de l'achèvement d'une exécution, de la sélection de résultats ou de l'ouverture d'aperçus, et les transitions d'exécution admissibles sont écrites dans des emplacements durables par voie qui se fondent en points de contrôle. (#4615, #4617)
- Le résumé système de l'appareil de calcul s'aligne sur la comptabilité native de chaque plateforme : l'utilisation sous macOS correspond à Activity Monitor (mémoire en cache exclue), et Windows affiche la mémoire validée par rapport à sa limite avec des seuils par défaut réglés. (#4599, #4600)

## 🐛 Bug Fixes

- Sous Windows, une mise à jour dans l'application ne reste plus bloquée pendant que l'Agent intégré ou l'assistant d'images tourne — les deux sont désormais reconnus comme les propres assistants d'installation de l'application, et l'enregistrement de l'assistant est appliqué automatiquement pour qu'un nouvel assistant ne puisse plus jamais être oublié. (#4602, #4606, #4611)
- Les versions stables de Windows publient à nouveau le delta d'installation compact utilisé pour les mises à jour delta ; un delta manquant pour une version déjà publiée peut être réparé sans réexpédier la version. (#4605)
- Les abonnements aux films CodeBuddy préparent désormais correctement leur première requête de modèle, et les conversations secondaires de l'Agent intégré conservent leurs points de contrôle sous le profil propre à la conversation. (#4616)
- Les versions d'édition d'image générées s'ouvrent de façon fiable dans l'aperçu d'image complet pendant que leur version est encore en cours de publication. (#4603)
- Les codes d'état HTTP en amont explicites sont présentés comme des faits fournisseur : un 402 tel que « Solde insuffisant » affiche désormais une explication de facturation exploitable, avec le code d'état et les détails sûrs du fournisseur préservés. (#4601)
- Sous Windows, le premier flux de tracé Python ne reste plus bloqué sur une barrière de récupération de noyau résiduelle provenant d'une voie sans rapport. (#4620)
- Lorsqu'une action d'outil est refusée, le tour se termine désormais par une explication durable au lieu de se taire, et les compteurs de refus restent distincts du travail achevé. (#4517)
- Les connexions CodeBuddy restaurent le modèle sélectionné lors de la reprise d'une session portant un historique, de sorte que les mises à jour d'utilisation de jetons continuent de circuler. (#4631)
- Les générations de film de recherche restent visibles : la conversation demeure dans l'onglet Active avec son état de film affiché, et un dialogue de film bloqué peut ouvrir la conversation qui détient la génération. (#4633)
- L'Agent intégré accepte les continuations d'outils comportant des champs d'identité nuls au lieu de faire échouer le tour. (#4638)

## 🙏 Remerciements

- Merci à tous ceux qui signalent des problèmes de mise à jour, de Notebook et de surveillance de la mémoire sur [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai) et [Discussions](https://github.com/aipoch/open-science/discussions).
- Merci à [@wen2zhou](https://github.com/wen2zhou) pour les contributions au traçage de l'Agent par projet et au traçage CLI par exécution ([#4514](https://github.com/aipoch/open-science/pull/4514), [#4618](https://github.com/aipoch/open-science/pull/4618)).
