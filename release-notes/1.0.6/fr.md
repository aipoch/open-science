## ✨ Highlights

- **Importez votre bibliothèque Zotero.** La bibliothèque Literature gagne l'import depuis Zotero : apportez une bibliothèque personnelle ou des collections sélectionnées depuis Zotero 10 ou ultérieur sur le même ordinateur, en conservant les métadonnées bibliographiques, les PDF, les étiquettes, les hiérarchies de collections et les liens sources, avec les références existantes associées au lieu d'être dupliquées. (#3949)
- **L'ordre de lecture des PDF est automatique.** L'ouverture d'un PDF lié n'affiche plus de commandes d'ordre de lecture persistantes au-dessus du document. L'extraction privilégie les balises logiques propres au fichier et se replie sur l'analyse de mise en page lorsque les balises sont absentes ou ambiguës, et les messages historiques avec des régions manuelles sont lus dans le nouvel ordre automatique. (#3979)
- **L'installation Windows est plus rapide et plus sûre.** Le temps d'installation passe d'une médiane de ~21 s à ~14 s avec un tiers de fichiers de charge en moins et une extraction parallèle, les mises à jour ne suppriment plus les données de recherche stockées à côté de l'application, et les installations vers des chemins de dossiers profonds aboutissent au lieu d'échouer à l'étape de copie. (#3957, #3963, #3946)
- **Les longs tours conservent leurs artefacts.** La publication des artefacts n'expire plus au bout de deux heures au cours d'un tour d'assistant encore en cours : les capacités vivent désormais pendant toute la durée du tour ouvert, de sorte que les sessions nocturnes et les longs traitements par lots publient leurs fichiers comme avant. (#3980)

## 🚀 New Features

- Recherchez dans la bibliothèque Literature par notes personnelles — une note comme « cette méthode convient à mes données » retrouve désormais sa référence via la boîte de recherche habituelle. (#3942)
- Les connecteurs stdio personnalisés configurés avec npx ou npm s'exécutent désormais sur des machines dépourvues de ces commandes, en utilisant le runtime Node et npm fourni avec l'application, tandis que les commandes installées gardent la priorité. (#3954)

## 🔧 Improvements

- Les PDF traduits s'ouvrent plus vite : la vérification des sources de traduction enregistrée recouvre désormais les lectures par petits lots lors de la première ouverture, et le processus de traduction local inutilisé a été retiré de l'installation, réduisant sa taille. (#3982, #3978)
- Les observations de file d'attente, de contrôleur et de comptabilité Slurm se résolvent indépendamment ; les résultats finaux des tâches sont persistés avant la collecte des journaux, les annulations délivrent exactement un résultat final, et les courtes commandes SSH sous Windows ne se bloquent plus sur un canal d'entrée inactif. (#3937)
- Les menus à bouton partagé — envoi/mise en file/arrêt de conversation, approbations d'autorisation, sélection de conversation Literature, outils de marquage et de zone PDF — partagent un seul panneau connecté avec un placement automatique, des animations réversibles et des boutons principal et flèche utilisables indépendamment. (#3925)
- Les alertes de sécurité signalées sont traitées par des mises à jour de dépendances compatibles et une analyse bornée en lieu et place d'une correspondance de motifs sujette au retour arrière. (#3956)
- Le guide de configuration WSL indique désormais d'emblée que la mise en réseau en mode miroir exige Windows 11 22H2 ou ultérieur, au lieu de recommander un mode que Windows 10 ne peut pas fournir. (#3945)
- L'autorisation interactive des identifiants attend votre approbation jusqu'à cinq minutes, et la récupération après délai explique ce qui s'est passé au lieu de ressembler à un problème de clé manquante. (#3939)

## 🐛 Bug Fixes

- Les sessions OpenCode ne se terminent plus par une erreur interne lorsque le nom d'un appel d'outil arrive après son premier fragment de sortie, les résumés de compaction 1.x restent hors des conversations et de la relecture de l'historique, et les configurations volumineuses ne manquent plus de se lancer sous Windows. (#3970, #3967, #3948)
- Le démarrage sous Windows accepte les magasins de cookies comportant des champs de charge binaires au lieu de bloquer la préparation au lancement par un échec de déchiffrement. (#3955)
- Les sessions R natives sous Windows fonctionnent lorsque le répertoire temporaire de l'application contient des espaces. (#3958)
- La fenêtre de bureau ne perd plus la synchronisation lorsqu'une lecture d'instantané de session arrive pendant que tous les canaux de transfert de gros volumes sont occupés. (#3969)
- L'envoi d'un premier message n'affiche plus la réflexion et le temps écoulé avant que vous soumettiez réellement, et l'arrêt de la préparation restaure votre brouillon non envoyé. (#3931)
- Les sessions importées présentent les échecs de livraison passés sous forme d'historique réduit et dépliable au lieu d'une erreur actuelle au-dessus de l'action de branchement. (#3941)
- La barre d'outils d'aperçu DOCX reste au-dessus du contenu du document pendant le défilement, à n'importe quel zoom. (#3743)
