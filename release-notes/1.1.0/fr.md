## ✨ Highlights

- **Des films de recherche portables.** Exportez une session sous forme de film de recherche portable et narré, prêt à être partagé : les ressources de narration se téléchargent d'abord depuis le CDN intégré de l'application, avec une source en amont épinglée en repli, la génération exécute des contrôles préalables et récupère après les échecs, le minutage du terminal est figé pour un rendu stable, et les modèles utilisables ne requièrent plus de validation préalable du protocole. (#4077, #4102, #4104, #4106, #4114)
- **Outils Literature dans le CLI et MCP.** Recherchez et gérez la bibliothèque Literature depuis la ligne de commande et depuis les clients MCP, avec une navigation en lecture seule et des outils d'écriture pour tenir les références à jour. (#4120, #4122)
- **Synthèses par lots de papiers reprises sur interruption.** La génération de synthèses par lots reprend là où elle s'était arrêtée après une interruption, sans régénérer les résultats déjà achevés. (#4095 ; merci [@nasus2002](https://github.com/nasus2002))
- **Refonte du centre de ressources.** Le centre de ressources est renommé avec une disposition de la bibliothèque de cas adaptée, les liens de ressources externes dans les paramètres sont plus compacts, et les paramètres de calcul rejoignent le groupe des connexions. (#4018, #4090, #4087)
- **Enregistrement de ressources en opt-in (Windows).** Les diagnostics peuvent enregistrer l'utilisation des ressources pendant votre travail — identités des processus, activité des sessions et mémoire de validation système — et inclure les preuves dans une archive de diagnostic exportée, avec un échantillonnage qui se met en pause lorsque la machine est inactive ou suspendue. (#4062)
- **Connectez un appareil mobile.** Appairez un téléphone ou une tablette en scannant un code QR et ouvrez-y l'espace de travail courant, via le WiFi local ou un tunnel Pinggy avec reconnexion automatique et sélection de région ; les tunnels Internet indiquent que le trafic transite par les serveurs de Pinggy. (#4129)

## 🚀 New Features

- Exportez toute session sous forme de film de recherche portable avec relecture du terminal et narration vocale. (#4077)
- Utilisez les outils de la bibliothèque Literature depuis le CLI et MCP : recherche et navigation en lecture seule, plus des outils d'écriture pour gérer les références. (#4120, #4122)
- Enregistrez l'utilisation des ressources depuis les Diagnostics sur Windows pour diagnostiquer l'épuisement des ressources, avec des contrôles de démarrage et d'arrêt et des preuves incluses dans les archives exportées. (#4062)
- Appairez un appareil mobile en scannant un code QR et ouvrez-y l'espace de travail courant, via le WiFi local ou un tunnel Pinggy. (#4129)

## 🔧 Improvements

- Les conversations récupèrent après les interruptions et les défaillances de stockage au lieu de perdre l'échange en cours. (#4097)
- Les exports de diagnostic préservent les preuves d'exécution du Notebook, consignent les diagnostics d'instantané d'export, permettent de sélectionner des journaux backend historiques et traitent le filtrage normal des journaux comme un export réussi. (#4083, #4086, #4063, #4108)
- L'extraction de structure des PDF récupère les figures et les tableaux à partir de scans avec texte au lieu de les abandonner, et préserve les limites de recadrage natives et la provenance du texte. (#4078, #4132)
- Les appels d'inférence OpenCode restreints n'imposent plus de résumés, et la sortie d'inférence restreinte est cohérente d'un framework d'agents à l'autre. (#4119, #4115)
- La réutilisation des connexions ACP au repos est désormais bornée, réduisant la croissance mémoire pendant les longues journées de travail. (#4103)
- La préparation des mises à jour Windows interroge l'identité et l'occupation des processus nativement au lieu de s'appuyer sur des outils système externes. (#4069)
- Le démarrage attend la découverte avant le délai d'attente du premier client et préserve l'état d'échec tout au long du nettoyage du runtime. (#4082, #4070)
- La place de marché d'import présélectionne le projet courant et utilise des libellés simplifiés. (#4109, #4105)
- La section Literature clarifie les libellés d'import d'identifiants et préserve les PDF partiels après les échecs de génération. (#4072, #4113)
- Les exports de molécules préservent les grandes structures dans les molfiles. (#4075)
- Les skills CodeBuddy résolvent leurs ressources pour les outils natifs et WSL. (#4076)
- Les panneaux de l'espace de travail disposent de poignées de redimensionnement qui suivent le pointeur. (#4131, #4133)

## 🐛 Bug Fixes

- Le Notebook privilégie le runtime géré par défaut prêt, les exécutions shell en échec sont signalées comme des erreurs MCP, et un run en échec n'implique plus que tous les runs ont échoué. (#4101, #4112, #4093)
- La récupération du renderer ne se bloque plus pendant les opérations du runtime. (#3972)
- Les panneaux de l'espace de travail restent contraints dans la fenêtre d'affichage, et les interactions de questions en attente sont simplifiées. (#4107, #4094)
- L'ACP ne récupère plus prématurément les continuations ask-user. (#4096)
- L'accès réseau du Notebook suit une politique HTTPS unique avec approbation explicite des points de terminaison non sécurisés, et la revue de code ne signale plus de faux positifs de risque pour les callbacks scalaires. (#4098, #4130)
- Les images natives s'affichent sur le pont Codex Chat. (#4128)
- Les preuves de sauvegarde de session survivent à la récupération de champs compacts, et la suppression d'une session n'attend plus une reconnexion du framework. (#4123, #4121)
- L'export d'un film de recherche en MP4 depuis un bureau connecté ouvre à nouveau la boîte de dialogue d'enregistrement au lieu d'échouer. (#4126)
