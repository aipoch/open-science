## ✨ Lo más destacado

- **Memoria de agente persistente.** El agente ahora puede recordar lo importante entre sesiones. Las entradas de memoria opcionales, organizadas en categorías por proyecto, se recuperan automáticamente cuando una conversación las toca, y todo se puede consultar, editar y borrar desde los ajustes. (#1432)
- **Flujos de trabajo de figuras con procedencia.** Las habilidades científicas integradas incorporan ayudas registradas para el estilo de figuras, la composición multipanel y las narrativas listas para publicación, construidas sobre entradas de artefactos inmutables, de modo que cada figura sigue siendo trazable hasta los datos que la produjeron. (#1864)
- **Gestión centralizada de credenciales.** Los tokens de GitHub, las claves de conectores y los inicios de sesión de conectores viven en un solo lugar, con el estado de salud de un vistazo, una recuperación guiada cuando una credencial deja de funcionar, y la reverificación automática de los conectores afectados una vez corregida la credencial. (#1865)
- **Una visión más completa del uso.** El panel de uso ahora atribuye el consumo de tokens a la ejecución que lo produjo y cuenta las llamadas a modelos fuera de la conversación principal: chats laterales, delegación y compactación de contexto incluidas. (#1877, #1874)

## 🚀 Novedades

- **Memoria de agente persistente** — categorías de memoria opcionales por proyecto que el agente recupera antes de los turnos pertinentes; las entradas se crean, corrigen y eliminan desde un panel de ajustes dedicado, y la recuperación queda limitada al proyecto de la conversación para no mezclar trabajo ajeno. (#1432)
- **Gestión centralizada de credenciales** — un solo panel para tokens de acceso personal de GitHub, claves de API de conectores e inicios de sesión de conectores, con estado de salud, recuperación guiada y aceptación de claves en planes gratuitos con límites de tasa para fuentes de datos abiertas. (#1865)
- **Proveedor Tencent TokenHub** con endpoints internacionales y de China continental, más un primer conjunto de modelos de Tencent. (#1880)
- **Flujos de trabajo de figuras con procedencia en las habilidades integradas** — ayudas registradas para el estilo de figuras, la composición multipanel y las narrativas listas para publicación, que consumen entradas de artefactos inmutables y mantienen las figuras trazables hasta los datos que las produjeron. (#1864)
- **Atribución de uso por ejecución** — el uso de tokens se atribuye a la ejecución que lo produjo y se persiste, de modo que el panel sigue siendo fiel entre reinicios. (#1877)

## 🔧 Mejoras

- El panel de uso ahora incluye las llamadas a modelos que ocurren fuera de la conversación principal — chats laterales, delegación y compactación de contexto —, de modo que los totales coinciden con lo que factura su proveedor. (#1874)
- Las cargas de habilidades expandidas muestran el documento cargado en Markdown formateado, se recuperan con un reintento cuando el documento no está disponible y se expanden sin saltos de desplazamiento. (#1812)
- Una descarga de actualización fallida ya no es un callejón sin salida: el diálogo de actualización sigue siendo operable y puede reintentar de inmediato. (#1868)
- Las descargas de actualizaciones y las instalaciones de entornos de ejecución se han reforzado: los manifiestos se validan antes de usarse, los instaladores deben proceder del origen de confianza y las instalaciones agotadas se limpian por completo. (#1873)
- La salida de errores del agente se resume en lugar de verterse en los registros, manteniendo la investigación cotidiana y las rutas locales fuera del diagnóstico; las muestras en bruto siguen disponibles como herramienta de soporte opcional. (#1858)
- El entorno de ejecución de CodeBuddy ya no envía informes de errores de ejecución. (#1856)
- El selector de modelos explica por qué un modelo no está disponible actualmente en lugar de deshabilitarlo en silencio. (#1879)
- Los flujos de eventos de la Task API y la CLI incorporan una identidad de ejecución estable con repetición acotada, de modo que los consumidores se reconectan sin confundir ejecuciones consecutivas, y los flujos revocados o terminados dejan de reintentar en vez de ciclar para siempre. (#1875)
- Los campos obligatorios y los errores de campo ahora se exponen a las tecnologías de asistencia. (#1869)

## 🐛 Correcciones

- **Backend de Claude** — una respuesta de Claude interrumpida se reanuda en lugar de quedarse colgada (#1853); las credenciales de bucle local sobreviven a reinicios y reconfiguraciones (#1878, #1859); y los permisos de herramientas otorgados por el agente ya no quedan ocultos por ajustes obsoletos (#1848).
- **Sesiones** — un primer turno concurrido ya no oculta la respuesta del agente cuando los detalles de sesión y el registro de uso se solapan (#1876), y las actualizaciones de registro consecutivas se reproducen limpiamente (#1860).
- **Servicio local y headless** — los cuerpos de solicitudes concurrentes y las difusiones WebSocket están acotados, y los clientes atascados se desconectan para que el servicio localhost siga respondiendo bajo carga. (#1857)
- **Ejecuciones largas** — los eventos de ejecución en bruto se liberan tras procesarse, de modo que las tareas de larga duración retienen bastante menos memoria. (#1855)
- **Notebook** — los metadatos internos de enrutamiento ya no llegan a las llamadas a modelos del notebook. (#1861)
- **Acceso a carpetas** — una respuesta obsoleta de diálogo ya no puede cerrar el diálogo de concesión equivocado ni informar de una carpeta desactualizada. (#1870)
- **Conectores** — la cancelación se deshabilita mientras hay un guardado en curso, protegiendo la continuación del inicio de sesión OAuth. (#1867)
- **Espacio de trabajo** — la vista previa de sesión ya no permanece abierta bajo los menús de acciones abiertos. (#1852)
