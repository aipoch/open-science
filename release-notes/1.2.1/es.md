## ✨ Highlights

- **Un solo lugar para cada recurso.** El Centro de recursos ahora gestiona skills, conectores y especialistas — incluida la instalación desde el Marketplace, también en la interfaz web — con tarjetas, filtros y vistas de detalle compartidas, y las referencias a skills se abren en el panel del proyecto sin salir de la conversación. (#4270)
- **Optimización del prompt científico.** Afine el prompt del proyecto actual desde el compositor con un clic; revise, edite o deshaga el resultado, y guarde plantillas personalizadas en Configuración del proyecto. La optimización solo se ejecuta a través de su proveedor configurado cuando usted la invoca. (#3991)
- **Un Agente integrado más potente.** Las cuentas de suscripción de Codex ya están disponibles para el agente principal y los subagentes, Claude Fable 5.2 se suma a la lista de modelos, y las respuestas largas ya no se cortan en 4.096 tokens. (#4250, #4249, #4275)
- **Las sesiones de investigación largas se exportan sin interrupciones.** Las ejecuciones de Notebook y Compute almacenan su evidencia una sola vez en un formato compacto y verificable, de modo que las exportaciones `.science` de historiales largos se mantienen rápidas y pequeñas. (#4248, #4258, #4240)
- **Inicio de sesión en cómputo en la nube que sobrevive a redes reales.** Modal y Hugging Face aprovisionan un runtime de Python compatible antes de abrir el navegador, y la verificación de la cuenta ahora sigue su proxy del sistema. (#4255)

## 🚀 New Features

- Gestione Skills, Connectors y Specialists — e instale desde el Marketplace, incluido el renderizador web — desde el Centro de recursos unificado, con tarjetas de catálogo coherentes, filtros con reinicio, selección múltiple y paneles de detalle; las referencias a skills del compositor y de los mensajes enviados se abren en el panel del Centro de recursos del proyecto sin alterar la conversación activa ni el borrador. (#4270)
- Optimice el prompt del proyecto activo desde el compositor: revise y edite el resultado antes de que reemplace el borrador, Deshacer restaura el texto anterior y los archivos adjuntos pegados eliminados, y las plantillas de optimización personalizadas viven en Configuración del proyecto. La optimización es manual y solo se ejecuta a través del proveedor configurado cuando se invoca. (#3991)
- Use cuentas de suscripción de Codex importadas o propias de la aplicación para el agente principal y los subagentes del Agente Open-Science integrado; el inicio de sesión, la actualización y el reemplazo de credenciales reutilizan los flujos de conexión de Codex existentes. (#4250)
- Seleccione Claude Fable 5.2 con una ventana de contexto de 1M en la lista de modelos de Anthropic incluida. (#4249)
- Exporte los metadatos de la bibliografía como CSV junto a BibTeX y RIS — referencias seleccionadas entre páginas con exclusiones individuales, o un proyecto o colección completo — usando 16 nombres de columna estables en inglés, con celdas vacías para los valores ausentes. (#4262)

## 🔧 Improvements

- El Agente integrado respeta el límite de salida anunciado por cada modelo (el valor configurado, luego los metadatos exactos del proveedor y, como alternativa, 16.384 tokens) y prefiere el protocolo de extremo nativo de cada modelo, de modo que las respuestas largas admitidas por el proveedor llegan completas. (#4275)
- El Agente integrado mide correctamente su uso de contexto y compacta mucho más tarde en sesiones largas. (#4209)
- Una pregunta respondida del Agente ya no espera a un vaciado de persistencia diferido, eliminando la interrupción «completion has not committed yet» antes de que la respuesta continúe. (#4279)
- Los destinos de cómputo de Modal y Hugging Face comparten un único flujo de preparación del runtime de Python: el intérprete seleccionado se comprueba sin instalar en él, las llamadas de autorización y del SDK permanecen vinculadas a él, y un resultado de autorización obsoleto ya no puede sobrescribir una conexión más reciente. (#4255)
- La evidencia de Notebook y Compute se almacena una vez por contenido único con resúmenes verificados; las exportaciones de historiales largos — cientos de ejecuciones sobre los mismos archivos — producen paquetes compactos, y la primera exportación rellena la evidencia histórica. (#4248, #4258, #4240, #4259)
- La generación de la película de investigación continúa cuando cambia de sesión, en lugar de detenerse con la conversación que la inició. (#4268)
- Los intérpretes inactivos de Python, R, REPL y Shell se reclaman tras 15 minutos sin actividad de la sesión, con grupos pequeños por tipo, de modo que las conversaciones terminadas ya no acumulan runtimes residentes. (#4274)
- El aviso de restablecimiento de contexto se descarta solo tras seis segundos, y las tarjetas del catálogo de recursos mantienen compactos sus avatares de uso. (#4281, #4276)

## 🐛 Bug Fixes

- Los archivos de Notebook adjuntos en el chat vuelven a abrir una vista previa, y los enlaces a archivos locales en las respuestas abren el archivo correspondiente. (#4257)
- Se desbloquea el empaquetado de actualizaciones firmadas de Windows, y la recuperación de actualizaciones nombra los archivos y procesos que retienen la aplicación, poda los registros de arranque cerrados y resuelve los bloqueos sin inmovilizar el instalador. (#4233, #4230, #4231, #4247)
- Las importaciones de literatura conservan el enrutamiento de identificadores y las mayúsculas y minúsculas de los DOI. (#4225)
- Las vistas previas de fuentes web vuelven a ser responsivas en diseños estrechos. (#4220)
- La recuperación de la estructura de PDF externos se endurece frente a archivos dañados, y la traducción de PDF aísla los prompts de agente y las capacidades de herramienta por documento. (#4238, #4228)
- El emparejamiento móvil permanece desactivado hasta que usted lo selecciona, y los fallos del RPC de control remoto web explican lo ocurrido en lugar de fallar en silencio. (#4221)
- Los detalles del error del proveedor sobreviven a través del runtime del agente, y los fallos de clasificación de solicitudes de OpenCode ya no se filtran más allá de la solicitud que los sufrió. (#4237, #4261)
- Los commits de conversación confirman los eventos terminales de forma fiable, las importaciones del CLI local autorizadas vuelven a funcionar en los paquetes de sesión, y la navegación del primer mensaje se restaura en conversaciones largas. (#4269, #4267, #4260)
- La recuperación de Linux ya no confunde hilos del kernel confirmados con procesos de Notebook filtrados. (#4265)

## 🙏 Agradecimientos

- Gracias a [@wen2zhou](https://github.com/wen2zhou) por el soporte de suscripciones de Codex en el Agente integrado ([#4250](https://github.com/aipoch/open-science/pull/4250)), la preparación de runtimes de Modal y Hugging Face ([#4255](https://github.com/aipoch/open-science/pull/4255)) y las vistas previas de archivos en el chat ([#4257](https://github.com/aipoch/open-science/pull/4257)).
- Gracias a [@roxi3906](https://github.com/roxi3906) por la optimización del prompt por proyecto ([#3991](https://github.com/aipoch/open-science/pull/3991)).
- Gracias a [@nasus2002](https://github.com/nasus2002) por la exportación CSV bibliográfica ([#4262](https://github.com/aipoch/open-science/pull/4262)) y las correcciones de manejo de DOI ([#4225](https://github.com/aipoch/open-science/pull/4225)).
- Gracias a [@guch96](https://github.com/guch96) por la corrección de continuación de preguntas respondidas ([#4279](https://github.com/aipoch/open-science/pull/4279)) y la recuperación de actualizaciones de Windows ([#4230](https://github.com/aipoch/open-science/pull/4230)), a [@cyj1116](https://github.com/cyj1116) por las mejoras de emparejamiento móvil ([#4221](https://github.com/aipoch/open-science/pull/4221)), y a [@daanveer-tech](https://github.com/daanveer-tech) por la documentación de benchmarks del README ([#4219](https://github.com/aipoch/open-science/pull/4219), [#4227](https://github.com/aipoch/open-science/pull/4227)).
