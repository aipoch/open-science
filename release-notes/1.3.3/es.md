## ✨ Highlights

- **Actualizaciones que no interrumpen su trabajo.** En macOS, una actualización elegible puede instalarse al salir de la aplicación; en Windows y Linux, puede prepararse una actualización para el próximo inicio mientras usted trabaja. Las descargas en segundo plano solo se realizan con una red sin restricciones y suficiente almacenamiento, y la ruta manual de descargar y reiniciar siempre está disponible; en Linux, la ruta del AppImage se conserva entre actualizaciones. Las descargas de actualizaciones también son más pequeñas, y las actualizaciones estables de Windows pueden aplicarse como deltas compactos. (#4542, #4518, #4586, #4510)
- **El Agent integrado es el predeterminado en todas partes.** Los proyectos y sesiones nuevos se inician con el Open-Science Agent integrado —incluidas las instalaciones limpias de CLI y SDK, que ya no fallan al arrancar cuando falta un SDK de agente externo. Instalar un runtime externo sigue siendo una elección explícita, que se hace solo cuando lo necesita. (#4531)
- **Una aplicación más ligera.** El escritorio instalado es más pequeño en macOS y Windows, y el runtime npm sin conexión incluido ahora se compila para Node 22 en lugar de incluir más de mil archivos de paquetes sueltos. (#4555, #4572, #4563, #4592, #4587)
- **Edición de imágenes unificada.** Las instrucciones de edición viven en el compositor de la conversación, las acciones de pasar el cursor y del teclado entran en la edición desde cualquier vista previa, y la navegación de versiones y la comparación permanecen disponibles en todo momento. (#4481)
- **Los fallos se explican por sí mismos.** En toda la aplicación, los errores opacos ahora indican lo que ocurrió realmente: fallos de solicitudes, problemas de carga e importación, errores de ejecución de Notebook y la diferencia entre el trabajo que usted detuvo y el que nunca respondió. (#4565, #4571, #4548, #4549, #4545, #4540, #4583, #4593)

## ⚠️ Alcance y seguridad

- **Las actualizaciones automáticas se descargan en segundo plano.** macOS instala una actualización solo al salir; Windows y Linux la preparan solo mientras el escritorio está inactivo en segundo plano; todas requieren evidencia positiva de una red sin restricciones ni medición de datos y de suficiente almacenamiento local, incluida una caché de actualizaciones escribible en Linux. Las conexiones limitadas o con medición mantienen la ruta totalmente manual. (#4542, #4518, #4586)
- **Instalar un runtime de agente externo descarga desde un registro npm.** Al elegir un marco externo, el instalador gestionado de la aplicación descarga su runtime desde el registro npm —o su réplica alternativa documentada— y verifica la descarga antes de usarla. Algunos runtimes gestionados resuelven la última versión publicada, mientras que otros incluyen versiones fijadas o un archivo lockfile confirmado en el repositorio y solo se actualizan con una versión de la aplicación. El Agent integrado no necesita semejante descarga. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.3/docs/security.md#data-recipients). (#4531)

## 🚀 New Features

- En las compilaciones estables empaquetadas oficiales de macOS, una actualización elegible puede instalarse automáticamente al salir de la aplicación; los volúmenes de solo lectura, App Translocation y las instalaciones no escribibles mantienen la ruta manual. (#4542)
- En las instalaciones estables empaquetadas de Windows, una preferencia activada de forma predeterminada prepara las actualizaciones para el próximo inicio al arrancar una vez que el espacio de trabajo está listo, el escritorio está en segundo plano, la conexión no tiene restricciones y el almacenamiento tiene espacio; la descarga manual sigue disponible. (#4518)
- En las instalaciones empaquetadas de Linux, una preferencia activada de forma predeterminada prepara las actualizaciones del AppImage para el próximo inicio mientras el escritorio está inactivo en segundo plano, condicionada a una conexión sin restricciones y a espacio en la caché de actualizaciones; la ruta del AppImage se conserva entre actualizaciones y la descarga manual sigue disponible. (#4586)
- El catálogo de proveedores de Bailian añade la familia de modelos qwen4, con el plan predeterminado en la vista previa de qwen4. (#4594)
- Ajustes restaura los accesos directos de Skills, Specialists y Connectors, cada uno abre la categoría instalada y regresa a su posición en Ajustes. (#4538)
- Las actualizaciones estables de Windows pueden aplicarse como deltas de instalador compactos e independientemente reproducibles, y los mapas de origen del escritorio de producción ya no incrustan el texto fuente original. (#4510)

## 🔧 Improvements

- La aplicación de escritorio instalada es más pequeña: las copias auditadas de dependencias del lado de Electron se podan en macOS y Windows, las dependencias de backend de terceros se recortan y los módulos internos de los paquetes del backend se agrupan en un único paquete, el runtime npm sin conexión se compila en un único paquete para Node 22, y el compilador de películas y los recursos web se compactan. (#4555, #4572, #4563, #4554, #4592, #4587)
- Los proyectos y sesiones nuevos usan de forma predeterminada el Open-Science Agent integrado; los runtimes de agentes externos se instalan bajo demanda a través del instalador gestionado y verificado. (#4531)
- El compositor muestra los fallos opacos de solicitudes en la vista de detalles, explica los fallos de entrega de mensajes en cola, las vistas previas explican los fallos de carga de archivos y fuentes, los fallos de lectura del historial de conversaciones quedan explicados, y los fallos de preparación y limpieza de adjuntos dicen qué salió mal. (#4565, #4583, #4571, #4548, #4539)
- Los entornos de Notebook conservan sus manifiestos en archivos auxiliares, los plazos de shell se amplían conservando las causas de detención, las lecturas de historial y el coste de maquetación de salidas largas son menores, y los errores de conectores aparecen en la lista de herramientas del host. (#4547, #4544, #4533, #4551)
- Las respuestas transmitidas siguen siendo fluidas en conversaciones largas gracias a un trabajo de segmentación de texto acotado, y el editor de imágenes mantiene los mensajes de la conversación inmóviles mientras introduce una edición. (#4520, #4559)
- La aplicación omite la relectura de documentos de skill incluidos sin cambios y omite el recorrido de ramas para aprobaciones de red vacías. (#4534, #4535)

## 🐛 Bug Fixes

- Los detalles de error del proveedor conservan el código de fallo clasificado y el id de solicitud, de modo que los fallos de modelo siguen siendo accionables tras un reinicio. (#4590)
- En Windows, los umbrales de memoria de Notebook se limitan a la memoria física instalada, las ejecuciones bloqueadas conservan sus lecturas de memoria, y se muestran la presión de memoria de macOS y los límites de cgroup de Linux. (#4593)
- En Windows, los bloqueos de archivos obsoletos dejados por una sesión anterior se vuelven a comprobar y caducan en un inicio en frío, de modo que una actualización preparada puede terminar de aplicarse. (#4591)
- Las entradas de sesiones de la bandeja navegan con resúmenes recuperados mientras la proyección duradera aún está poniéndose al día. (#4582)
- Reparaciones en la traducción de PDF: la extracción nativa que dividía oraciones en saltos de columna, pies de ilustración o fórmulas en línea se reconecta usando evidencia de fuente, glifo y geometría, y el texto traducido ya no desplaza la notación nativa, las etiquetas de formularios ni los gráficos adyacentes. (#4560)
- El trabajo detenido se etiqueta correctamente: los prompts detenidos por el usuario se resuelven tras la limpieza, una ejecución detenida se distingue de una continuación sin respuesta, los diagnósticos obsoletos ya no reemplazan los mensajes de cancelación, y las sesiones inactivas recuperan los marcadores de ejecución separados. (#4552, #4545, #4537)
- Los fallos de modelo se clasifican con precisión: los fallos ascendentes se distinguen de las respuestas mal formadas y del agotamiento de pila del lado del cliente, los diagnósticos seguros se conservan, y el ciclo de vida del flujo de Responses ya no informa de finalización antes de tiempo. (#4540, #4511)
- En Windows, los kernels de Notebook recuperan su estado de runtime tras un reinicio, y la clave de perfil se inicializa antes de las comprobaciones de actualización en caché. (#4529, #4569)
- Los nombres de archivo de respuestas resuelven al artefacto guardado, la eliminación de categorías de memoria se vincula a notas confirmadas, y los paquetes de sesión permiten que las lecturas de Notebook se resuelvan antes de explicar los fallos de exportación. (#4562, #4512, #4564)
- Las vistas previas de edición de imágenes permanecen estables, los detalles de imagen muestran el kernel de Notebook que produjo una edición, y la acción de actualización se oculta cuando el dispositivo de cómputo ya está preparado. (#4553, #4557, #4558)
- Las lecturas de archivos de proyecto explican los fallos y comprueban las reparaciones inciertas, las importaciones de skills de GitHub explican los fallos de conexión, y se reparan las regresiones de sesiones programadas y de certificación. (#4541, #4532, #4530)

## 🙏 Agradecimientos

- Gracias a [@cyj1116](https://github.com/cyj1116) por los controles unificados de edición de imágenes y la navegación de versiones ([#4481](https://github.com/aipoch/open-science/pull/4481)).
