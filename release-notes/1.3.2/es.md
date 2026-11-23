## ✨ Highlights

- **Las conversaciones largas usan menos memoria.** Las respuestas transmitidas ya no acumulan entradas de rendimiento ocultas, y el cuerpo de las conversaciones que no está viendo se libera una vez guardado de forma segura: las sesiones grandes siguen siendo fluidas sin perder su posición, los cambios pendientes ni el trabajo activo. (#4500)
- **Kilo Gateway es un proveedor oficial.** Añádalo con o sin clave de API: una actualización anónima del catálogo muestra los modelos gratuitos para los que su conexión es elegible, y el paso de proveedor de la incorporación puede omitirse para decidir más adelante. Las credenciales existentes y las elecciones del modelo principal se conservan al actualizar. (#4465)
- **Catálogos de modelos de imágenes que puede comprobar.** Los servicios de imágenes oficiales de OpenAI, MiniMax, Bailian y Volcengine Ark pueden actualizar su lista de modelos incluida desde el proveedor antes de guardar, conservando su modelo activo cuando sigue disponible. (#4474)
- **Primeros mensajes fiables en las sesiones de agente.** Las conversaciones nuevas de Agent predeterminado, Claude Code y Codex ya no fallan antes de su primera solicitud al modelo, y el Agent integrado inicia las sesiones programadas con su mensaje previsto. (#4505, #4490)
- **Traducción de PDF que conserva el diseño original.** Los títulos, pies de ilustración, definiciones y enunciados matemáticos divididos se recuperan en el orden de lectura, y las fórmulas, enlaces y gráficos permanecen en su lugar original en el documento traducido. (#4492)

## ⚠️ Alcance y seguridad

- **Añadir Kilo sin una clave contacta con Kilo de forma anónima.** La actualización del catálogo que muestra los modelos gratuitos elegibles es una solicitud a los servidores de Kilo que no lleva ninguna identidad de cuenta. Las solicitudes de imágenes y modelos tras la configuración van a Kilo como con cualquier otra conexión de proveedor. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4465)
- **Comprobar un catálogo de modelos de imágenes contacta con el proveedor.** Una actualización envía las credenciales de la conexión configurada a ese proveedor para enumerar sus modelos de imágenes, y una comprobación fallida no puede retirar lo que ya se ha enviado. Ejecútela solo para conexiones que usted haya configurado. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4474)

## 🚀 New Features

- Añada Kilo Gateway como proveedor oficial con una clave de API opcional; una actualización anónima del catálogo muestra los modelos gratuitos elegibles, y guardar sin una clave mantiene abierta la elección del modelo. (#4465)
- El paso de proveedor de la incorporación en el escritorio ofrece una acción Omitir que añade Kilo sin una clave y deja la decisión del modelo en sus manos; las actualizaciones añaden la configuración de Kilo que falte sin modificar las credenciales de proveedor existentes ni las elecciones del modelo principal. (#4465)
- Los servicios de imágenes oficiales de OpenAI, MiniMax, Bailian y Volcengine Ark pueden comprobar el catálogo en vivo de modelos de imágenes del proveedor bajo demanda: los modelos incluidos que coinciden se muestran antes de guardar, el modelo activo se conserva y un modelo mantenido como predeterminado pero ausente del catálogo actualizado queda marcado. (#4474)
- Las solicitudes del catálogo de imágenes de Bailian se limitan a la región del espacio de trabajo, y las credenciales vinculadas a China están limitadas al catálogo de China. (#4474)

## 🔧 Improvements

- Las conversaciones y sesiones largas usan menos memoria: las respuestas transmitidas ya no acumulan entradas de rendimiento ocultas, los cuerpos de las conversaciones inactivas se liberan una vez que su copia persistente coincide, y las actualizaciones de sesiones en curso reutilizan copias serializadas para la entrega y la reproducción. (#4500)
- La presión de memoria de Notebook se anuncia mediante un aviso descartable con una caducidad de seis segundos en lugar de ocupar la fila superior del espacio de trabajo o abrir un modal; la negativa a iniciar se aplica solo a las decisiones de ejecución reales, y la recuperación se anuncia una vez completada. (#4499)
- La pantalla principal indica el motivo específico por el que falló la descarga de un caso de uso —un manifiesto que falta, un paquete no disponible, un tiempo de espera, la red, el servidor, la verificación, el disco lleno o un problema de almacenamiento— en lugar de un fallo genérico. (#4498)
- La reproducción mantiene limpias las conversaciones históricas: las acciones de preguntar y capturar de los pasos completados aparecen al pasar el cursor o con el foco del teclado, con objetivos de tamaño completo en dispositivos táctiles o de puntero híbrido. (#4483)

## 🐛 Bug Fixes

- Las conversaciones nuevas de Agent predeterminado, Claude Code y Codex ya no fallan antes de su primera solicitud al modelo cuando la preparación de la autoridad de Notebook reanuda una sesión nativa ya adjunta o sin historial. (#4505)
- El Agent integrado abre las sesiones programadas con su primer mensaje en lugar de interrumpir un escritor adjunto durante la actualización de credenciales de Notebook. (#4490)
- La traducción de PDF recupera el texto que la extracción nativa dividió entre filas o límites de página —títulos, pies de ilustración, definiciones y enunciados matemáticos— y mantiene las fórmulas, el texto de referencia, los enlaces y los gráficos incrustados en sus ubicaciones originales durante la reescritura. (#4492)
- El inicio de Notebook ya no interpreta erróneamente como un fallo una canalización de comandos de WSL cerrada. (#4500)

## 🙏 Agradecimientos

- Gracias a [@ShuangChenyue](https://github.com/ShuangChenyue) por los motivos específicos de fallo en la descarga de casos de uso ([#4498](https://github.com/aipoch/open-science/pull/4498)).
- Gracias a [@liguohhh](https://github.com/liguohhh) por las comprobaciones del catálogo de modelos de imágenes oficiales ([#4474](https://github.com/aipoch/open-science/pull/4474)) y la incorporación de Kilo Gateway ([#4465](https://github.com/aipoch/open-science/pull/4465)).
