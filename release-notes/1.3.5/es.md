## ✨ Highlights

- **Actualizaciones de macOS más pequeñas.** Las actualizaciones dentro de la aplicación en macOS ahora descargan deltas firmados en lugar de blockmaps ZIP, de modo que una actualización solo transfiere lo que cambió —y un delta faltante ya no puede convertirse silenciosamente en una descarga completa. (#4649)
- **Lea literatura sin perder el hilo.** Las figuras y tablas se previsualizan directamente desde las referencias en el texto, y los pasajes seleccionados se traducen en el lugar —los PDF de una sola página solo de imágenes ahora se abren con una capa de texto seleccionable. (#4681, #4667)
- **Más formas de conectar modelos.** Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry y Vectrust se unen al catálogo de proveedores, junto a presets dedicados de Ollama, LM Studio, llama.cpp y vLLM con descubrimiento de modelos locales. (#4662)
- **Una aplicación más ligera y estable.** El historial de transcripciones y las figuras de Notebook se cargan bajo demanda, los escaneos del catálogo de inicio y la escritura en el espacio de trabajo cuestan menos, y la admisión de memoria de Notebook se vuelve a comprobar antes de continuar el trabajo de escritorio. (#4676, #4678, #4695)

## ⚠️ Alcance y seguridad

- **Las nuevas conexiones de proveedores envían datos a los puntos finales que usted configura.** Las solicitudes a través de una pasarela en la nube (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) van a ese proveedor bajo sus condiciones; los presets locales (Ollama, LM Studio, llama.cpp, vLLM) mantienen el tráfico en la máquina o red a la que usted los apunte. Revise el destino antes de encaminar contenido sensible del proyecto a través de una conexión recién añadida. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients). (#4662)

## 🚀 New Features

- Los proveedores ganan **presets de pasarelas en la nube** (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) con puntos finales y autenticación específicos de cada protocolo, y **presets de modelos locales** (Ollama, LM Studio, llama.cpp, vLLM) con descubrimiento de modelos locales; los proveedores en la nube y locales comparten una lista de modelos editable con nombres para mostrar, ventanas de contexto y esfuerzo de razonamiento. (#4662)
- Las figuras y tablas se **previsualizan en línea desde las referencias en el texto** en el lector de PDF, incluso cuando el artículo solo enlaza el número o nada en absoluto. (#4681)
- El lector de PDF puede **traducir un pasaje seleccionado en el lugar**, conservando su posición de lectura; los PDF de literatura de una sola página solo de imágenes se abren con una capa de texto seleccionable. (#4667)
- Configuración gana un **selector de servicio de imágenes** que muestra los servicios oficiales antes del formulario personalizado, y la lista de proveedores se reordena para que las suscripciones activas aparezcan primero. (#4650)
- La configuración de escritorio en Windows ahora instala el lanzador del comando `open-science`, de modo que los agentes externos pueden controlar la aplicación justo después de una instalación silenciosa. (#4679)
- Los agentes externos pueden ejecutar bucles agrupados de CLI/MCP contra la aplicación a través del contrato de adaptador de agente compartido. (#4661)

## 🔧 Improvements

- Las sesiones largas se sienten más ligeras: el historial de transcripciones y las figuras de Notebook se cargan bajo demanda en lugar de todo a la vez, y los escaneos del catálogo de inicio y la escritura en el espacio de trabajo hacen menos trabajo por pulsación de tecla. (#4676, #4678)
- La admisión de memoria de Notebook vuelve a comprobar la memoria disponible antes de continuar el trabajo de escritorio, y los umbrales de memoria multiplataforma se reducen para ajustarse al margen real. (#4695, #4643)
- La disponibilidad de modelos ahora se explica por causa, de modo que un modelo inutilizable le dice por qué en lugar de simplemente fallar. (#4696)
- Las instalaciones gestionadas de agentes sondean los registros de npm de forma concurrente, reduciendo la espera de configuración en redes lentas. (#4660)
- El contraste del tema y la visibilidad de los iconos de proveedores mejoran en los modos claro y oscuro. (#4655)

## 🐛 Bug Fixes

- La traducción de PDF conserva el diseño nativo con mayor fidelidad, con una segmentación y reescritura de PDF científicos mejoradas, y la verificación de la vista previa se separa para que los problemas de diseño afloren antes de la entrega. (#4671, #4693, #4697)
- La reanudación de sesiones se recupera cuando un proveedor de modelos no está disponible temporalmente, y las ejecuciones reanudadas se validan contra su estado de recuperación duradero en lugar de fallar de plano. (#4672, #4652)
- Los reintentos del puente de proveedores ahora conservan el error original del modelo en lugar de enmascararlo. (#4653)
- Robustez de Notebook: los metadatos de transferencia y la salida de shell guardada sobreviven a la recuperación de sesiones, los sondeos de inicio permanecen acotados al carril en recuperación, y las figuras capturadas se renderizan cuando se expanden las filas de herramientas. (#4657, #4647, #4677)
- Los paquetes de sesión dirigen el espacio temporal a la raíz de datos en lugar de a la unidad del sistema. (#4665)
- Actualizaciones: vuelve el recordatorio de actualización destacado, las actualizaciones de Windows toleran desconexiones transitorias del runtime, y las descargas del runtime se reintentan ante fallos de red. (#4646, #4645, #4644)
- Los vídeos de investigación conservan el texto alternativo para destinos que no son imágenes, la navegación de investigación importada se mantiene receptiva, y los archivos de trabajo capturados ya no provocan advertencias de truncamiento espurias. (#4670, #4663, #4648)

## 🙏 Agradecimientos

- Gracias a todos los que reportan problemas de actualizaciones, de Notebook y de proveedores de modelos en [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai) y [Discussions](https://github.com/aipoch/open-science/discussions).
- Gracias a [@liguohhh](https://github.com/liguohhh) por los presets de pasarelas en la nube y de modelos locales ([#4662](https://github.com/aipoch/open-science/pull/4662)).
- Gracias a [@nasus2002](https://github.com/nasus2002) por las vistas previas de figuras y tablas en el texto ([#4681](https://github.com/aipoch/open-science/pull/4681)).
- Gracias a [@guch96](https://github.com/guch96) por el bucle de agente agrupado de CLI/MCP y las nuevas comprobaciones de memoria de Notebook ([#4661](https://github.com/aipoch/open-science/pull/4661), [#4695](https://github.com/aipoch/open-science/pull/4695)).
- Gracias a [@ShuangChenyue](https://github.com/ShuangChenyue) por los sondeos concurrentes de registros y la recuperación de sesiones ante caídas de proveedores ([#4660](https://github.com/aipoch/open-science/pull/4660), [#4672](https://github.com/aipoch/open-science/pull/4672)).
- Gracias a [@cyj1116](https://github.com/cyj1116) por la recuperación de transferencias de Notebook y de salida de shell ([#4657](https://github.com/aipoch/open-science/pull/4657)).
