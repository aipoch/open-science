## ✨ Lo más destacado

- **Instaladores de Windows con firma de código.** Los paquetes estables de Windows ahora están firmados, de modo que la advertencia de SmartScreen de «aplicación no reconocida» ya no aparece en el primer lanzamiento. (#2980)
- **Enriquecimiento de interacciones de proteínas con STRING.** El conector de anotación de proteínas incorpora un análisis de enriquecimiento de PPI de STRING que puntúa las asociaciones funcionales de tu lista de genes. (#2984)
- **Vistas previas de fuentes en vivo persistentes.** Las vistas previas de fuentes en vivo en el navegador utilizan ahora una sesión persistente, de modo que los inicios de sesión y el estado sobreviven a los reinicios de la app. (#2824)

## 🚀 Novedades

- Los instaladores de Windows tienen firma de código: el primer lanzamiento es una experiencia normal, sin advertencias. (#2980)
- Enriquecimiento de PPI de STRING en el conector de anotación de proteínas: envía una lista de genes y recupera puntuaciones de enriquecimiento y la red de interacciones puntuada. (#2984)
- Las vistas previas de fuentes en vivo en el navegador se ejecutan en una partición persistente, manteniendo tu sesión entre visitas y entre reinicios. (#2824)
- El modo de permiso Library Auto interrumpe menos, pidiendo aprobación solo donde importa durante el trabajo habitual. (#2983)

## 🔧 Mejoras

- Las descargas de la app ahora apuntan a la página oficial de descarga, con notas de verificación enlazadas desde allí. (#2987)

## 🐛 Correcciones

- **Delegación** — los resultados completados sobreviven a los fallos de limpieza en lugar de perderse (#2977); el flujo de trabajo de delegación del Figure Composer se actualiza (#2981).
- **Espacio de trabajo** — los iconos de tipo de archivo ahora aparecen en las cabeceras de vista previa, coincidiendo con las listas del espacio de trabajo (#2982); las opciones de colecciones inteligentes reciben un espaciado más ajustado y coherente (#2985).
- **Notebook** — las obligaciones de limpieza retenidas de macOS se aíslan, de modo que el trabajo en notebook no se ve bloqueado por la contabilidad de limpieza no relacionada (#2919).
- **Tiempo de ejecución del agente** — el enrutamiento nativo de Responses y la cancelación de desmontaje se conservan (#2972).
- **Backend de Codex** — el descubrimiento de complementos y de la app está desactivado, lo que reduce la actividad inesperada en segundo plano (#2979).
