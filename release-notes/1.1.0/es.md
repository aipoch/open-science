## ✨ Highlights

- **Películas de investigación portátiles.** Exporte una sesión como una película de investigación portátil y narrada que puede compartir: los recursos de narración se descargan primero desde la CDN integrada de la aplicación, con un origen de respaldo fijado, la generación ejecuta comprobaciones previas y se recupera de los fallos, el ritmo del terminal se congela para una salida estable, y los modelos utilizables ya no requieren validación previa del protocolo. (#4077, #4102, #4104, #4106, #4114)
- **Herramientas de Literature en la CLI y MCP.** Busque y gestione la biblioteca Literature desde la línea de comandos y desde clientes MCP, con exploración de solo lectura más herramientas de escritura para mantener las referencias actualizadas. (#4120, #4122)
- **Resúmenes por lotes de artículos que se pueden reanudar.** La generación de resúmenes por lotes continúa donde se quedó tras las interrupciones, sin regenerar los resultados ya completados. (#4095; thanks [@nasus2002](https://github.com/nasus2002))
- **Rediseño del centro de recursos.** El centro de recursos se renombra con una disposición adaptada de la biblioteca de casos, los enlaces de recursos externos en Configuración son más compactos, y la configuración de cómputo pasa al grupo de conexiones. (#4018, #4090, #4087)
- **Grabación de recursos opcional (Windows).** El diagnóstico puede registrar el uso de recursos mientras trabaja — identidades de proceso, actividad de sesión y memoria de confirmación del sistema — e incluir la evidencia en un archivo de diagnóstico exportado, con un muestreo que se pausa cuando la máquina está inactiva o suspendida. (#4062)
- **Conexión de un dispositivo móvil.** Empareje un teléfono o una tableta escaneando un código QR y abra en él el espacio de trabajo actual, por WiFi local o a través de un túnel de Pinggy con reconexión automática y selección de región; los túneles por Internet informan de que el tráfico pasa por los servidores de Pinggy. (#4129)

## 🚀 New Features

- Exporte cualquier sesión como una película de investigación portátil con reproducción del terminal y narración de voz. (#4077)
- Use las herramientas de la biblioteca Literature desde la CLI y MCP: búsqueda y exploración de solo lectura, además de herramientas de escritura para gestionar las referencias. (#4120, #4122)
- Registre el uso de recursos desde Diagnóstico en Windows para diagnosticar el agotamiento de recursos, con controles de inicio y detención y evidencia incluida en los archivos exportados. (#4062)
- Empareje un dispositivo móvil escaneando un código QR y abra en él el espacio de trabajo actual, por WiFi local o a través de un túnel de Pinggy. (#4129)

## 🔧 Improvements

- Las conversaciones se recuperan tras interrupciones y fallos de almacenamiento en lugar de perder el intercambio activo. (#4097)
- Las exportaciones de diagnóstico conservan la evidencia de ejecución de Notebook, registran diagnósticos de instantáneas de exportación, permiten seleccionar registros históricos del backend y tratan el filtrado normal de registros como una exportación exitosa. (#4083, #4086, #4063, #4108)
- La extracción de estructura de PDF recupera figuras y tablas de escaneos con texto en lugar de descartarlas, y conserva los límites de recorte nativos y la procedencia del texto. (#4078, #4132)
- Las llamadas de inferencia restringidas de OpenCode ya no fuerzan resúmenes, y la salida de inferencia restringida es consistente entre frameworks de agentes. (#4119, #4115)
- La reutilización de conexiones ACP inactivas está limitada, reduciendo el crecimiento de memoria durante las jornadas largas. (#4103)
- La preparación de actualizaciones de Windows consulta la identidad de proceso y la ocupación de forma nativa en lugar de depender de herramientas externas del sistema. (#4069)
- El arranque espera al descubrimiento antes del tiempo de espera del primer cliente y conserva el estado de fallo durante la limpieza del runtime. (#4082, #4070)
- El marketplace de importación preselecciona el proyecto actual y usa etiquetas simplificadas. (#4109, #4105)
- Literature aclara las etiquetas de importación de identificadores y conserva los PDF parciales tras los fallos de generación. (#4072, #4113)
- Las exportaciones de moléculas conservan estructuras grandes en archivos molfile. (#4075)
- Las skills de CodeBuddy resuelven sus recursos tanto para herramientas nativas como para WSL. (#4076)
- Los paneles del espacio de trabajo tienen asas de redimensionamiento que siguen al puntero. (#4131, #4133)

## 🐛 Bug Fixes

- Notebook prefiere el runtime gestionado predeterminado que está listo, las ejecuciones de shell fallidas se informan como errores de MCP, y una ejecución fallida ya no implica que todas las ejecuciones hayan fallado. (#4101, #4112, #4093)
- La recuperación del renderizador ya no se bloquea durante las operaciones de runtime. (#3972)
- Los paneles del espacio de trabajo permanecen dentro del viewport, y las interacciones de preguntas pendientes se simplifican. (#4107, #4094)
- ACP ya no recupera prematuramente las continuaciones de ask-user. (#4096)
- El acceso a la red de Notebook sigue una única política HTTPS con aprobación explícita para puntos finales no seguros, y la revisión de código ya no informa de falsos positivos de riesgo para callbacks escalares. (#4098, #4130)
- Las imágenes nativas se muestran en el puente de Codex Chat. (#4128)
- La evidencia de guardado de sesión sobrevive a la recuperación de campos compactos, y eliminar una sesión ya no espera a una reconexión del framework. (#4123, #4121)
- Exportar una película de investigación como MP4 desde un escritorio conectado vuelve a abrir el diálogo de guardado en lugar de fallar. (#4126)
