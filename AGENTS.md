# Arturia API

API en TypeScript estricto y definiciones de infraestructura en AWS CDK v2. Leer explícitamente el `AGENTS.md` de administración del workspace en los directorios padre cuando esté disponible.

- `contracts/` es la fuente del contrato HTTP y SSE. Mantener los esquemas y fixtures compatibles con el consumidor web.
- Separar el dominio de los adaptadores de transporte y persistencia. Toda operación de datos se aísla por usuario y ámbito.
- Usar datos e identidades sintéticas en las pruebas, con reloj controlado donde corresponda. Mantener las credenciales y el contenido de los mensajes fuera de logs y colas.
- Ejecutar `npm ci`, `npm run verify`, `npm run verify:local` y `npm run synth` para comprobar cambios de base. Usar el proyecto Vitest correspondiente y agregar filtros después de `--`.
- `README.md` y `README.es.md` contienen la referencia técnica.

## Flujo Git

- `dev` es la rama predeterminada y la base de desarrollo. Crear `feat/<tema>` o `fix/<tema>` desde `dev` e integrarlas mediante PR hacia `dev`.
- Para publicar una versión, crear `release/x.x.x` desde `dev` y abrir un PR hacia `main`. Las integraciones a `main` se hacen desde ramas `release/`.
- Fuera de `dev` y `main`, solo se permiten los prefijos `feat/`, `fix/` y `release/`. No usar `codex/`. Verificar el nombre antes de crear una rama.
- `dev` y `main` requieren PR, CI y el control `branch-policy` aprobados, conversaciones resueltas y merge commit. No hacer push directo, force-push ni borrar estas ramas.
- Mantener commits pequeños y descriptivos. Usar títulos semánticos en español para commits y PR, con un cuerpo de PR que indique alcance y validación.
- Commit, push, merge, release y despliegue requieren autorización explícita del pedido vigente.
- Tras un merge autorizado, verificar que no queden cambios ni integraciones pendientes y eliminar la rama remota integrada. Conservar las ramas destino, los tags y las ramas locales.
