## ✨ Lo más destacado

- **Los kernels protegidos de los Notebooks se inician directamente en Windows.** Los kernels de Windows arrancan bajo el sandbox de red sin la ruta de lanzamiento indirecta que podía dejarlos sin protección o impedir que se iniciaran. (#2081)
- **La exportación de archivos se publica de forma atómica.** Los archivos exportados aparecen solo cuando se han escrito por completo, de modo que una exportación fallida o interrumpida ya no deja un archivo parcial, y las exportaciones de paquetes conservan marcas de tiempo válidas en todas las zonas horarias. (#2070, #2072)
- **Las vistas previas de las imágenes generadas quedan restauradas.** Las imágenes que genera el agente vuelven a mostrar sus vistas previas en lugar de recurrir a marcadores de posición. (#2082)
- **Las incoherencias del catálogo de habilidades se recuperan por sí solas.** Configuración detecta y repara las incoherencias del catálogo en lugar de dejar habilidades ausentes o duplicadas. (#2080)

## 🐛 Correcciones

- **Notebook y cálculo** — los límites de concurrencia de sesión persisten entre reinicios (#2077); la recuperación de la finalización de artefactos admite reintentos después de un intento fallido (#2068); y los contratos obsoletos de selección del entorno de ejecución ya no bloquean el inicio de los kernels. (#2073)
- **Archivos y artefactos** — el contexto de lectura de PDF conserva la identidad lógica del archivo cuando el archivo subyacente se reemplaza (#2094); y las ediciones del detalle de sesión ya no se sobrescriben entre sí con datos obsoletos. (#2079)
- **Sesiones y persistencia** — las combinaciones obsoletas de recuperación de sesiones se normalizan al arrancar (#2092); los turnos de Task se admiten antes de la persistencia, de modo que el trabajo en cola no se pierde (#2078); y la limpieza de datos relacionados se recupera y continúa tras un fallo de eliminación. (#2074)
- **Agentes y proveedores** — el uso de las llamadas al modelo de Claude ya finalizadas se recupera en las estadísticas de uso (#2086); CodeBuddy conserva los argumentos de comando vacíos en Windows (#2089); y los paquetes de especialistas se recuperan de las interrupciones con una orientación clara sobre su origen. (#2076)
- **Espacio de trabajo y configuración** — la aplicación limpia los escuchas del ciclo de vida del renderizador que podían acumularse en sesiones largas (#2083); y las incoherencias del catálogo de habilidades se detectan y reparan automáticamente. (#2080)
