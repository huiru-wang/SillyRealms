# World, App Settings and Session model association

Status: Implemented, 2026-11-08 (breaking change)

## Chosen behavior

- `app_settings` is a one-row (`id=1`) application settings table. `default_preset_id` and `default_api_model_config_id` are independently nullable. A built-in ordinary narrative preset is seeded, but no fake API model or key is created.
- Importing a World Card copies both App defaults **once** into `worlds.default_preset_id` and `worlds.default_api_model_config_id`. Changing App defaults does not alter previously imported Worlds or Sessions. An incomplete World may be imported but must be configured before creating a Session.
- Creating a Session validates the World's current defaults and API credential, then copies both IDs into `sessions.preset_id` and `sessions.api_model_config_id` in the same transaction as the opening entry. These Session references are required (NOT NULL). A Session never dynamically falls back to World/App defaults.
- The Host Session settings can change either reference while its Run is not active. `ContextManager` resolves the Preset and the API model config independently from the Session on each Run. Prompt/summary policy still lives in the Preset, **not** the model association. Provider/model/key live in the API model config.
- Existing Sessions keep their referenced IDs when a World or App default changes, but editing the referenced Preset or API model config object affects subsequent Runs. Per-Run config snapshots are out of scope.
- Deletes of referenced Presets or API model configs are rejected with HTTP 409 `CONFIG_IN_USE`. Response errors retain details about reference counts and missing World configuration.

## World Card storage and original file

- API interchange remains `world_card@0.1` with `{spec,spec_version,data}`; storage is new, deliberately incompatible with the old `data_json` column.
- The World repository maps fixed top-level card data to SQL columns. Nested JSON (`characters`, `openings`, `lorebook`, state definition, message rendering, creator UI, extensions) stays in individual JSON columns. Tags stay relational. `worlds.state` is the runtime global state, separate from the card's state definition.
- Imported original JSON bytes live at `${SILLYREALMS_DATA_DIR}/workspaces/worlds/{worldId}/source/original.json`. The DB stores the server-generated relative path and SHA-256 digest. `GET /v1/worlds/:id/source` returns the original bytes only after checksum verification. `GET /v1/worlds/:id/export` reconstructs the **current** World Card from DB without internal config IDs.
- `WorldFileStore` owns file operations and UUID-scoped paths; it writes through a temporary file and atomic rename, deletes a World's source on World deletion and can remove orphaned UUID folders at startup under the exclusive data-directory lock.

## Breaking reset and operational notes

- No legacy schema/data/API/client compatibility or historical migration was implemented, as requested.
- `pnpm --filter @sillyrealms/server reset:data` is a **destructive, explicitly named** operation. It acquires the same data-directory lock as the server and deletes only `sillyrealms.sqlite`, its `-wal` / `-shm` sidecars, and `workspaces/worlds` inside `SILLYREALMS_DATA_DIR` (default `db/`). A running server prevents the reset. `data/`, other data-root files and macOS Keychain are outside the reset scope.
- Stop the server before resetting and start it again to create the new schema. A new instance is ready with the default narrative preset and no API model. Re-enter a real model configuration via the Web UI before creating a Session.
- The former on-disk SR DB was intentionally reset on 2026-11-08 and the server was started successfully at `127.0.0.1:3000`. The original project `data/` worktree files were untouched by this refactor.

## Verification

- Tests exercise App-to-World copying, World-to-Session copying, Session model overrides, independent Agent model selection, source byte identity and SHA-256 enforcement, reference protection, failed import rollback and orphan cleanup.
- Follow `plan/sr-world-config-storage-refactor.md` for the complete scope and acceptance matrix. This decision supersedes older references to `worlds.data_json`, `worlds.preset_id`, or a model association embedded in `presets.config_json`.
