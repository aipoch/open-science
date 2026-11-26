## ✨ Highlights

- **Recherche web et lecture de pages pour l'agent intégré.** L'agent Open-Science peut effectuer des recherches sur le web et lire des pages publiques. Les approbations de recherche affichent la requête et ses filtres dans une carte lisible, et les sources citées restent attachées à la conversation au fil des redémarrages, des branches et des paquets de recherche. (#4448, #4471)
- **Graphe de citations interactif.** Les références d'un article et les articles qui le citent apparaissent sous forme de graphe à explorer. Recentrez le graphe sur n'importe quel article lié, filtrez par sens de citation et revenez à l'article d'origine. (#4418, #4467)
- **Utilisez votre agent via MCP sans ouvrir l'application.** Lorsqu'un agent externe se connecte à Open-Science via MCP, le service d'arrière-plan démarre tout seul. Le guide de configuration couvre désormais plus de 30 agents et clients. (#4470, #4464)
- **Modèles Lab et cas d'organisation.** Connectez-vous avec un compte Lab pour utiliser les modèles attribués par votre organisation, et recherchez, importez ou partagez des cas de recherche avec vos collègues. (#4447)
- **Listes de modèles à jour et erreurs de fournisseur plus claires.** Actualisez la liste des modèles d'un fournisseur depuis les Paramètres. Lorsqu'une requête au fournisseur échoue, la conversation en indique la cause et propose l'étape suivante adaptée. (#4415)

## ⚠️ Portée et sécurité

- **La mise à jour depuis la 1.3.0 peut nécessiter une installation manuelle.** Le programme de mise à jour de la 1.3.0 peut confondre l'un des processus d'arrière-plan de l'application avec un autre programme et refuser d'installer. Cette version ne peut pas modifier le programme de mise à jour déjà en cours d'exécution dans la 1.3.0. Si la mise à jour signale qu'un autre processus utilise l'installation, quittez complètement Open-Science et son service d'arrière-plan, puis installez manuellement le paquet téléchargé. Vos profils et vos données de recherche restent intacts. Les mises à jour lancées depuis la 1.3.1 ne sont pas concernées. Voir le [registre des limites connues](https://github.com/aipoch/open-science/blob/v1.3.1/docs/known-limitations.md). (#4454)
- **La recherche web et la lecture de pages contactent des services externes.** Les requêtes de recherche sont envoyées à Exa, un service de recherche tiers, sans compte. La lecture d'une page contacte le site web de cette page. Les deux outils respectent votre mode de permission, et l'arrêt d'une requête ne peut pas rétracter ce qui a déjà été envoyé. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.1/docs/security.md#data-recipients). (#4448)
- **La connexion Lab change la destination des requêtes.** Avec un compte Lab, les requêtes vers les modèles Lab passent par le serveur Lab auquel vous vous connectez. Partager un cas téléverse le paquet de recherche de cette session vers ce serveur pour votre organisation. Vérifiez le paquet avant de le partager, et vérifiez un cas d'organisation avant de l'importer. (#4447)
- **Connecter un agent maintient le service en cours d'exécution.** La connexion d'un agent externe démarre le service d'arrière-plan, qui continue de s'exécuter après la déconnexion de l'agent. Arrêtez-le avec `open-science stop` lorsque vous n'en avez plus besoin. (#4470)

## 🚀 New Features

- L'agent Open-Science intégré peut effectuer des recherches sur le web et lire des pages publiques. Il cite ses sources, qui restent disponibles hors ligne, d'une branche à l'autre et dans les paquets de recherche qui l'autorisent. (#4448)
- Les approbations de recherche web affichent la requête, la période, la limite de résultats et les filtres de domaine dans une carte lisible. (#4471)
- Explorez le réseau de citations d'un article sous forme de graphe interactif. Choisissez Tout, Références ou Cité par, suivez les flèches qui indiquent le sens de citation, recentrez sur n'importe quel article lié et revenez à l'article d'origine. (#4418)
- Les agents externes connectés via MCP démarrent ou réutilisent le service Open-Science de votre profil au moment de la connexion, vous n'avez donc plus besoin d'ouvrir l'application au préalable. (#4470)
- Le README et le guide du CLI incluent un démarrage rapide pour agents externes, avec des options de configuration pour plus de 30 agents et clients locaux, et un premier appel qui confirme la connexion. (#4464)
- Connectez-vous avec un compte Lab pour utiliser les modèles de votre organisation et suivre leur consommation. Recherchez les cas de recherche de votre organisation, importez des cas vérifiés et téléversez une session pour la partager avec un code de partage. (#4447)
- Actualisez la liste des modèles d'un fournisseur depuis les Paramètres. En cas d'échec de l'actualisation, la liste précédente est conservée. (#4415)
- Les services d'images peuvent lancer une génération de test facultative avant leur enregistrement. L'enregistrement d'un nouveau service d'images sélectionne également son premier modèle lorsqu'aucun modèle par défaut n'est défini. (#4455)

## 🔧 Improvements

- Les échecs de fournisseur indiquent leur cause dans la conversation, notamment l'authentification, le quota, les limites de débit, les modèles indisponibles, la perte de connexion, les réponses interrompues et les limites de contexte, et proposent l'action de récupération adaptée. (#4415)
- Les exécutions Notebook vérifient la mémoire disponible avant de démarrer. Lorsque le système manque de mémoire, l'exécution n'est pas lancée et vous pouvez la relancer vous-même. Depuis Compute, vous pouvez choisir une session et libérer ses ressources Notebook, tandis que le travail actif reste protégé. (#4374)
- L'accueil du projet s'affiche plus tôt au démarrage. Les détails d'une session se chargent à son ouverture au lieu d'être tous chargés d'un coup. (#4434)
- Lorsque le dossier de recherche enregistré est introuvable, la boîte de dialogue de récupération au démarrage affiche le chemin de ce dossier et vous invite à reconnecter le disque. (#4472)
- L'accueil de premier lancement sous Windows ne s'arrête plus à l'étape WSL facultative. Vous pouvez configurer WSL2 Bash plus tard dans Paramètres → Environnements d'exécution. (#4463)
- Les échecs d'installation sous Windows affichent leurs diagnostics plus rapidement. (#4457)
- Les flèches du graphe de citations rejoignent leurs articles cibles, et l'indication hors écran prend moins de place sur les petits écrans. (#4467)

## 🐛 Bug Fixes

- Les mises à jour intégrées à l'application ne considèrent plus le propre processus de journalisation en arrière-plan de l'application comme un autre programme bloquant l'installation. (#4454)
- La désinstallation et la mise à jour sous Windows n'échouent plus lorsque le fichier de paramètres est volumineux. (#4469)
- Après une reconnexion, les sessions conservent les brouillons non envoyés, chargent les longs historiques à branches et acceptent les réponses aux questions restaurées après un plantage. Renommer ou épingler une session n'écrase plus les modifications plus récentes. (#4460)
- Une session dont les détails n'ont pas pu être chargés ne relance plus ce chargement en boucle. (#4452)
- Les nouvelles sessions d'agent n'affichent plus d'avertissements de littérature répétés pendant leur démarrage. (#4462)
- La suppression d'une session importée sous Windows supprime entièrement ses fichiers et ses enregistrements. (#4459)
- Une session Notebook ouverte seule charge l'historique de conversation de l'agent au lieu de démarrer sans lui. (#4461)

## 🙏 Remerciements

- Merci à [@wen2zhou](https://github.com/wen2zhou) pour la recherche web et la lecture de pages intégrées ([#4448](https://github.com/aipoch/open-science/pull/4448)).
- Merci à [@nasus2002](https://github.com/nasus2002) pour le graphe de citations interactif ([#4418](https://github.com/aipoch/open-science/pull/4418), [#4467](https://github.com/aipoch/open-science/pull/4467)).
- Merci à [@ShuangChenyue](https://github.com/ShuangChenyue) pour les modèles Lab et le partage de cas d'organisation ([#4447](https://github.com/aipoch/open-science/pull/4447)).
- Merci à [@liguohhh](https://github.com/liguohhh) pour l'actualisation de la liste des modèles et les erreurs de fournisseur plus claires ([#4415](https://github.com/aipoch/open-science/pull/4415)).
- Merci à [@guch96](https://github.com/guch96) pour les vérifications de mémoire Notebook et la libération des ressources ([#4374](https://github.com/aipoch/open-science/pull/4374)), et à [@liyeshunag](https://github.com/liyeshunag) pour la correction des avertissements de littérature dans les nouvelles sessions ([#4462](https://github.com/aipoch/open-science/pull/4462)).
