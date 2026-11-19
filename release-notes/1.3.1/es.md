## ✨ Highlights

- **Búsqueda web y lectura de páginas para el agente integrado.** El Open-Science Agent puede buscar en la web y leer páginas públicas. Las aprobaciones de búsqueda muestran la consulta y sus filtros en una tarjeta legible, y las fuentes que cita permanecen con la conversación tras reinicios, en ramas y en paquetes de investigación. (#4448, #4471)
- **Grafo de citas interactivo.** Las referencias de un artículo y los artículos que lo citan aparecen como un grafo que puede explorar. Vuelva a centrar el grafo en cualquier artículo relacionado, filtre por dirección y regrese al artículo original. (#4418, #4467)
- **Use su agente a través de MCP sin abrir la aplicación.** Cuando un agente externo se conecta a Open-Science a través de MCP, el servicio en segundo plano se inicia por sí solo. La guía de configuración cubre ahora más de 30 agentes y clientes. (#4470, #4464)
- **Modelos de Lab y casos de la organización.** Inicie sesión con una cuenta de Lab para usar los modelos que asigna su organización, y busque, importe o comparta casos de investigación con sus compañeros de equipo. (#4447)
- **Listas de modelos actualizadas y errores de proveedor más claros.** Actualice la lista de modelos de un proveedor desde Ajustes. Cuando falla una solicitud a un proveedor, la conversación indica la causa y ofrece el siguiente paso correspondiente. (#4415)

## ⚠️ Alcance y seguridad

- **Actualizar desde 1.3.0 puede requerir una instalación manual.** El actualizador de 1.3.0 puede confundir uno de los procesos en segundo plano de la propia aplicación con otro programa y negarse a instalar. Esta versión no puede cambiar el actualizador que ya se está ejecutando en 1.3.0. Si la actualización indica que otro proceso está usando la instalación, cierre por completo Open-Science y su servicio en segundo plano y, a continuación, instale manualmente el paquete descargado. Sus perfiles y datos de investigación se mantienen intactos. Las actualizaciones que parten de 1.3.1 no se ven afectadas. Consulte el [registro de limitaciones conocidas](https://github.com/aipoch/open-science/blob/v1.3.1/docs/known-limitations.md). (#4454)
- **La búsqueda web y la lectura de páginas contactan con servicios externos.** Las consultas de búsqueda se envían a Exa, un servicio de búsqueda de terceros, sin una cuenta. Leer una página contacta con el sitio web de esa página. Ambas herramientas siguen su modo de permisos, y detener una solicitud no puede retirar lo que ya se ha enviado. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.1/docs/security.md#data-recipients). (#4448)
- **Iniciar sesión en Lab cambia el destino de las solicitudes.** Con una cuenta de Lab, las solicitudes a los modelos de Lab pasan por el servidor de Lab en el que inicia sesión. Compartir un caso sube el paquete de investigación de esa sesión a ese servidor para su organización. Revise el paquete antes de compartirlo, y revise un caso de la organización antes de importarlo. (#4447)
- **Conectar un agente mantiene el servicio en ejecución.** Conectar un agente externo inicia el servicio en segundo plano, y el servicio sigue en ejecución después de que el agente se desconecte. Deténgalo con `open-science stop` cuando ya no lo necesite. (#4470)

## 🚀 New Features

- El Open-Science Agent integrado puede buscar en la web y leer páginas públicas. Cita sus fuentes, y esas fuentes siguen disponibles sin conexión, en todas las ramas y en los paquetes de investigación que lo permiten. (#4448)
- Las aprobaciones de búsqueda web muestran la consulta, el intervalo de tiempo, el límite de resultados y los filtros de dominio en una tarjeta legible. (#4471)
- Explore la red de citas de un artículo como un grafo interactivo. Elija Todas, Referencias o Citado por, siga las flechas que muestran la dirección de la cita, vuelva a centrar el grafo en cualquier artículo relacionado y regrese al artículo original. (#4418)
- Los agentes externos conectados a través de MCP inician o reutilizan el servicio de Open-Science de su perfil al conectarse, de modo que ya no necesita abrir la aplicación primero. (#4470)
- El README y la guía del CLI incluyen un inicio rápido para agentes externos, con opciones de configuración para más de 30 agentes y clientes locales y una primera llamada que confirma la conexión. (#4464)
- Inicie sesión con una cuenta de Lab para usar los modelos de su organización y seguir su uso. Busque los casos de investigación de su organización, importe casos verificados y suba una sesión para compartirla con un código para compartir. (#4447)
- Actualice la lista de modelos de un proveedor desde Ajustes. Si la actualización falla, se conserva la lista anterior. (#4415)
- Los servicios de imágenes pueden ejecutar una generación de prueba opcional antes de guardarlos. Al guardar un nuevo servicio de imágenes, también se selecciona su primer modelo cuando no hay ningún modelo predeterminado. (#4455)

## 🔧 Improvements

- Los fallos del proveedor indican su causa en la conversación, incluidos la autenticación, la cuota, los límites de frecuencia, los modelos no disponibles, la pérdida de conexión, las respuestas interrumpidas y los límites de contexto, y ofrecen la acción de recuperación correspondiente. (#4415)
- Las ejecuciones de Notebook comprueban la memoria disponible antes de empezar. Cuando el sistema tiene poca memoria, la ejecución no se inicia y usted puede reintentarla por su cuenta. Desde Compute, puede elegir una sesión y liberar sus recursos de Notebook mientras el trabajo activo permanece protegido. (#4374)
- La página principal del proyecto aparece antes al inicio. Los detalles de la sesión se cargan cuando abre una sesión en lugar de todos a la vez. (#4434)
- Cuando falta la carpeta de investigación guardada, el diálogo de recuperación al inicio muestra la ruta de esa carpeta y le pide que vuelva a conectar la unidad. (#4472)
- La incorporación inicial en Windows ya no se detiene en el paso opcional de WSL. Puede configurar WSL2 Bash más adelante en Ajustes → Runtimes. (#4463)
- Los fallos de instalación en Windows muestran sus diagnósticos más rápido. (#4457)
- Las flechas del grafo de citas llegan hasta sus artículos de destino, y el aviso de elementos fuera de pantalla ocupa menos espacio en pantallas pequeñas. (#4467)

## 🐛 Bug Fixes

- Las actualizaciones dentro de la aplicación ya no tratan el proceso de registro en segundo plano de la propia aplicación como otro programa que bloquea la instalación. (#4454)
- La desinstalación y la actualización en Windows ya no fallan cuando el archivo de ajustes es grande. (#4469)
- Tras una reconexión, las sesiones conservan los borradores no enviados, cargan historiales largos con ramas y aceptan respuestas a preguntas restauradas después de un fallo. Renombrar o fijar una sesión ya no sobrescribe cambios más recientes. (#4460)
- Una sesión cuyos detalles no se pudieron cargar ya no reintenta esa carga una y otra vez. (#4452)
- Las nuevas sesiones de agente ya no muestran advertencias de literatura repetidas mientras se inician. (#4462)
- Eliminar una sesión importada en Windows borra por completo sus archivos y registros. (#4459)
- Una sesión de Notebook abierta por sí sola carga el historial de conversación del agente en lugar de empezar sin él. (#4461)

## 🙏 Agradecimientos

- Gracias a [@wen2zhou](https://github.com/wen2zhou) por la búsqueda web y la lectura de páginas integradas ([#4448](https://github.com/aipoch/open-science/pull/4448)).
- Gracias a [@nasus2002](https://github.com/nasus2002) por el grafo de citas interactivo ([#4418](https://github.com/aipoch/open-science/pull/4418), [#4467](https://github.com/aipoch/open-science/pull/4467)).
- Gracias a [@ShuangChenyue](https://github.com/ShuangChenyue) por los modelos de Lab y el uso compartido de casos de la organización ([#4447](https://github.com/aipoch/open-science/pull/4447)).
- Gracias a [@liguohhh](https://github.com/liguohhh) por la actualización de la lista de modelos y los errores de proveedor más claros ([#4415](https://github.com/aipoch/open-science/pull/4415)).
- Gracias a [@guch96](https://github.com/guch96) por las comprobaciones de memoria y la liberación de recursos de Notebook ([#4374](https://github.com/aipoch/open-science/pull/4374)), y a [@liyeshunag](https://github.com/liyeshunag) por la corrección de las advertencias de literatura en sesiones nuevas ([#4462](https://github.com/aipoch/open-science/pull/4462)).
