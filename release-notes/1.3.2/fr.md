## ✨ Highlights

- **Les longues conversations consomment moins de mémoire.** Les réponses diffusées n'accumulent plus d'entrées de performance cachées, et les contenus de conversation que vous n'affichez pas sont libérés dès lors qu'ils sont sauvegardés en toute sécurité — les grandes sessions restent réactives sans perdre votre position, vos modifications en attente ni votre travail en cours. (#4500)
- **Kilo Gateway est un fournisseur officiel.** Ajoutez-le avec ou sans clé d'API : une actualisation anonyme du catalogue affiche les modèles gratuits auxquels votre connexion donne droit, et l'étape de fournisseur de l'accueil peut être ignorée pour décider plus tard. Les identifiants existants et le choix de modèle principal sont préservés lors de la mise à jour. (#4465)
- **Des catalogues de modèles d'images vérifiables.** Les services d'images officiels pour OpenAI, MiniMax, Bailian et Volcengine Ark peuvent actualiser leur liste de modèles intégrée auprès du fournisseur avant l'enregistrement, en conservant votre modèle actif lorsqu'il est toujours disponible. (#4474)
- **Des premiers messages fiables dans les sessions d'agent.** Les nouvelles conversations avec l'agent par défaut, Claude Code et Codex n'échouent plus avant leur première requête au modèle, et l'agent intégré ouvre les sessions planifiées avec leur invite prévue. (#4505, #4490)
- **Une traduction PDF qui conserve la mise en page native.** Les titres, légendes, définitions et énoncés mathématiques renvoyés à la ligne sont récupérés dans l'ordre de lecture, et les formules, liens et graphiques restent à leur place d'origine dans le document traduit. (#4492)

## ⚠️ Portée et sécurité

- **Ajouter Kilo sans clé contacte Kilo de manière anonyme.** L'actualisation du catalogue qui affiche les modèles gratuits éligibles est une requête vers les serveurs de Kilo qui ne porte aucune identité de compte. Les requêtes d'images et de modèles après la configuration sont envoyées à Kilo comme pour toute autre connexion à un fournisseur. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4465)
- **Vérifier un catalogue de modèles d'images contacte le fournisseur.** Une actualisation envoie les identifiants de la connexion configurée à ce fournisseur pour dresser la liste de ses modèles d'images, et un échec de la vérification ne peut pas rétracter ce qui a déjà été envoyé. Ne l'exécutez que pour des connexions que vous avez configurées. Voir [les destinataires de données](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4474)

## 🚀 New Features

- Ajoutez Kilo Gateway comme fournisseur officiel avec une clé d'API facultative ; une actualisation anonyme du catalogue affiche les modèles gratuits éligibles, et l'enregistrement sans clé laisse le choix du modèle ouvert. (#4465)
- L'étape de fournisseur de l'accueil sur le bureau gagne une action Ignorer qui ajoute Kilo sans clé et laisse la décision du modèle à votre main ; la mise à jour ajoute toute configuration Kilo manquante sans toucher aux identifiants de fournisseur existants ni au choix de modèle principal. (#4465)
- Les services d'images officiels pour OpenAI, MiniMax, Bailian et Volcengine Ark peuvent vérifier à la demande le catalogue vivant de modèles d'images du fournisseur : les modèles intégrés correspondants sont affichés avant l'enregistrement, le modèle actif est conservé, et un modèle conservé par défaut mais absent du catalogue actualisé est signalé. (#4474)
- Les requêtes de catalogue d'images Bailian sont limitées à la région de l'espace de travail, et les identifiants liés à la Chine sont restreints au catalogue de la Chine. (#4474)

## 🔧 Improvements

- Les longues conversations et sessions consomment moins de mémoire : les réponses diffusées n'accumulent plus d'entrées de performance cachées, les contenus de conversation inactifs sont libérés dès que leur copie durable correspond, et les mises à jour de session en direct réutilisent des copies sérialisées pour la diffusion et la relecture. (#4500)
- La pression mémoire de Notebook est signalée par un avis fermable expirant après six secondes au lieu d'occuper la ligne supérieure de l'espace de travail ou d'ouvrir une fenêtre modale ; le refus de démarrer ne s'applique qu'aux décisions d'exécution réelles, et la récupération est annoncée une fois terminée. (#4499)
- L'écran d'accueil indique la raison précise de l'échec du téléchargement d'un cas d'utilisation — un manifeste manquant, un paquet indisponible, un délai dépassé, un problème réseau, serveur, de vérification, de disque plein ou de stockage — au lieu d'un échec générique. (#4498)
- La relecture garde les conversations historiques épurées : les actions de demande et de capture pour les étapes terminées apparaissent au survol ou au focus clavier, avec des cibles en pleine taille sur les appareils tactiles ou à pointeur hybride. (#4483)

## 🐛 Bug Fixes

- Les nouvelles conversations avec l'agent par défaut, Claude Code et Codex n'échouent plus avant leur première requête au modèle lorsque la préparation de l'autorité Notebook reprend une session native déjà attachée ou sans historique. (#4505)
- L'agent intégré ouvre les sessions planifiées avec leur première invite au lieu d'interrompre un rédacteur attaché pendant l'actualisation des identifiants Notebook. (#4490)
- La traduction PDF récupère le texte que l'extraction native a divisé entre lignes ou limites de page — titres, légendes, définitions et énoncés mathématiques — et conserve les formules, le texte de référence, les liens et les graphiques intégrés à leur emplacement d'origine lors de la réécriture. (#4492)
- Le démarrage de Notebook ne considère plus comme un échec un canal de commande WSL fermé. (#4500)

## 🙏 Remerciements

- Merci à [@ShuangChenyue](https://github.com/ShuangChenyue) pour les raisons précises d'échec de téléchargement des cas d'utilisation ([#4498](https://github.com/aipoch/open-science/pull/4498)).
- Merci à [@liguohhh](https://github.com/liguohhh) pour les vérifications de catalogue de modèles d'images officiels ([#4474](https://github.com/aipoch/open-science/pull/4474)) et l'accueil de Kilo Gateway ([#4465](https://github.com/aipoch/open-science/pull/4465)).
