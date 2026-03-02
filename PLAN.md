# Plan strict d’intégration `tauri-specta` (complet + POC final)

**Résumé**
Objectif: remplacer progressivement le contrat IPC “stringly-typed” (`invoke('...')`, `listen('...')`) par un contrat typé généré (`commands.*`, `events.*`) via `tauri-specta`, sans régression runtime, avec un POC final visible dans l’app.

Le plan couvre:
1. l’infra Rust `tauri-specta`,
2. le typage complet commandes + events,
3. la migration frontend progressive puis totale,
4. le nettoyage des éléments obsolètes,
5. les tests de non-régression et le POC de démonstration.

**Constat initial vérifié dans le repo**
1. Backend Tauri: 89 commandes `#[tauri::command]` exposées, actuellement enregistrées via `tauri::generate_handler!` dans [main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs#L3866).
2. Frontend: enum `Invokes` central dans [AppProperties.tsx](/home/yann/dev/RapidRAW/src/components/ui/AppProperties.tsx#L8) + de nombreux `invoke('...')` en dur (ex: [LensCorrectionModal.tsx](/home/yann/dev/RapidRAW/src/components/modals/LensCorrectionModal.tsx#L208), [App.tsx](/home/yann/dev/RapidRAW/src/App.tsx#L653)).
3. Incohérences commandes:
`image_processing::generate_waveform` dans l’enum (backend expose `generate_waveform`),
`invoke_generative_replace` dans l’enum sans commande backend correspondante.
4. Incohérences events:
frontend écoute `export-cancelled`, `hdr-error`, `culling-error` mais backend ne les émet pas;
backend émet `indexing-error`, `panorama-warning`, `thumbnail-generation-error`, `export-complete-with-errors` mais frontend n’en fait pas de traitement central.
5. Edge technique majeur:
3 commandes renvoient `Result<Response, String>` (`generate_original_transformed_preview`, `generate_preset_preview`, `generate_preview_for_path`) et doivent être migrées vers `Vec<u8>` pour un contrat Specta propre (migration complète, mais hors POC comme demandé).

---

## Plan d’implémentation détaillé

### 1. Phase 0 — Préparation et garde-fous
Actions:
1. Geler un baseline technique: `cargo check` backend + `npm run build` frontend.
2. Ajouter une checklist de validation contractuelle (script shell repo) pour comparer:
backend commands vs usage frontend, backend events vs listeners frontend.
3. Fixer dès cette phase la convention de nommage officielle:
commandes Rust snake_case -> bindings TS camelCase.

Fichiers concernés:
[main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs), [AppProperties.tsx](/home/yann/dev/RapidRAW/src/components/ui/AppProperties.tsx), [App.tsx](/home/yann/dev/RapidRAW/src/App.tsx).

Critère de sortie:
baseline vert + inventaire automatique des écarts reproduisible.

### 2. Phase 1 — Infrastructure `tauri-specta` côté Rust
Actions:
1. Mettre à jour [Cargo.toml](/home/yann/dev/RapidRAW/src-tauri/Cargo.toml):
ajouter feature `specta` sur `tauri`,
ajouter `tauri-specta = "=2.0.0-rc.21"` avec features `derive, typescript`,
ajouter `specta` version compatible (`=2.0.0-rc.22`) avec features nécessaires (`derive`, `function`, `serde_json`),
ajouter `specta-typescript = "0.0.9"`.
2. Dans [main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs):
créer un `tauri_specta::Builder::<tauri::Wry>::new()`,
déclarer `.commands(collect_commands![...])` avec la liste complète actuelle,
déclarer `.events(collect_events![...])` (initialement vide puis complétée en phase events),
activer `.error_handling(ErrorHandlingMode::Throw)` pour conserver la sémantique frontend actuelle (`try/catch`),
remplacer `.invoke_handler(tauri::generate_handler![...])` par `.invoke_handler(builder.invoke_handler())`,
appeler `builder.mount_events(app)` dans `setup`.
3. Export TS:
générer `src/bindings.ts` depuis Rust en debug, en évitant les réécritures inutiles (comparaison `export_str` vs contenu existant avant écriture).

Fichiers concernés:
[Cargo.toml](/home/yann/dev/RapidRAW/src-tauri/Cargo.toml), [main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs), nouveau [bindings.ts](/home/yann/dev/RapidRAW/src/bindings.ts).

Critère de sortie:
`cargo check` passe avec `tauri-specta`, `bindings.ts` généré avec `commands` compilables.

### 3. Phase 2 — Couverture complète commandes et types Specta
Actions:
1. Ajouter `#[specta::specta]` sur les 89 commandes `#[tauri::command]` (dans `main.rs` + modules).
2. Dériver `specta::Type` sur tous les types transitant dans signatures commandes/events:
types de `main.rs` (ex: `ImageDimensions`, `LoadImageResult`, `ExportSettings`, `ResizeOptions`, `Watermark*`, `CommunityPreset`, `LutParseResult`),
types modules `file_management` (`AppSettings`, `ImageFile`, `FolderNode`, `ImportSettings`, `PresetItem`, etc.),
types modules `image_processing` (`ImageMetadata`, `Crop`, `GeometryParams`, `HistogramData`, `WaveformData`),
types modules `culling`, `negative_conversion`, `lens_correction`, `mask_generation`, `ai_processing`.
3. Traiter les erreurs de compilation Specta de façon itérative jusqu’à couverture totale des types imbriqués.
4. Migration binaire complète (hors POC mais dans l’intégration finale):
`Result<Response, String>` -> `Result<Vec<u8>, String>` pour:
`generate_original_transformed_preview`,
`generate_preset_preview`,
`generate_preview_for_path`.

Fichiers concernés:
[main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs),
[file_management.rs](/home/yann/dev/RapidRAW/src-tauri/src/file_management.rs),
[image_processing.rs](/home/yann/dev/RapidRAW/src-tauri/src/image_processing.rs),
[culling.rs](/home/yann/dev/RapidRAW/src-tauri/src/culling.rs),
[negative_conversion.rs](/home/yann/dev/RapidRAW/src-tauri/src/negative_conversion.rs),
[lens_correction.rs](/home/yann/dev/RapidRAW/src-tauri/src/lens_correction.rs),
[mask_generation.rs](/home/yann/dev/RapidRAW/src-tauri/src/mask_generation.rs),
[ai_processing.rs](/home/yann/dev/RapidRAW/src-tauri/src/ai_processing.rs).

Critère de sortie:
`bindings.ts` contient toutes les commandes avec signatures TS strictes, sans fallback `any` côté génération.

### 4. Phase 3 — Contrat events typé et unifié
Actions:
1. Définir des structs d’events typés (`Serialize`, `Deserialize`, `Type`, `Event`) pour chaque event métier actuellement utilisé/émis.
2. Enregistrer ces events via `collect_events![...]`.
3. Unifier le contrat event backend/frontend:
ajouter émissions backend manquantes pour préserver l’UX existante (`export-cancelled`, `hdr-error`, `culling-error`),
ajouter traitement frontend pour les events backend actuellement non gérés (`indexing-error`, `panorama-warning`, `thumbnail-generation-error`, `export-complete-with-errors`).
4. Convertir progressivement les `app_handle.emit("string", payload)` vers émissions typées `MyEvent { ... }.emit(...)` pour verrouiller les noms au compile-time.

Fichiers concernés:
[main.rs](/home/yann/dev/RapidRAW/src-tauri/src/main.rs),
[file_management.rs](/home/yann/dev/RapidRAW/src-tauri/src/file_management.rs),
[tagging.rs](/home/yann/dev/RapidRAW/src-tauri/src/tagging.rs),
[culling.rs](/home/yann/dev/RapidRAW/src-tauri/src/culling.rs),
[denoising.rs](/home/yann/dev/RapidRAW/src-tauri/src/denoising.rs),
[panorama_stitching.rs](/home/yann/dev/RapidRAW/src-tauri/src/panorama_stitching.rs),
[App.tsx](/home/yann/dev/RapidRAW/src/App.tsx),
[useThumbnails.tsx](/home/yann/dev/RapidRAW/src/hooks/useThumbnails.tsx).

Critère de sortie:
`events.*` générés dans `bindings.ts` couvrent tous les events utiles et le backend/front utilisent le même contrat.

### 5. Phase 4 — Migration frontend progressive vers `commands`/`events`
Actions:
1. Introduire l’import `commands, events` depuis [bindings.ts](/home/yann/dev/RapidRAW/src/bindings.ts).
2. Migrer par zones fonctionnelles pour minimiser le risque:
zone App core ([App.tsx](/home/yann/dev/RapidRAW/src/App.tsx)),
modales géométrie/lens/négatif,
exports,
presets,
thumbnails,
settings.
3. Remplacer `invoke(Invokes.X, ...)` par `commands.x(...)`.
4. Remplacer `listen('event-name', ...)` par `events.eventName.listen(...)`.
5. Remplacer les `any` de payload lorsque le type généré existe.
6. Conserver temporairement compatibilité mixte si nécessaire (zones non migrées), puis converger à 100%.

Fichiers principaux:
[App.tsx](/home/yann/dev/RapidRAW/src/App.tsx),
[AppProperties.tsx](/home/yann/dev/RapidRAW/src/components/ui/AppProperties.tsx),
[useThumbnails.tsx](/home/yann/dev/RapidRAW/src/hooks/useThumbnails.tsx),
[SettingsPanel.tsx](/home/yann/dev/RapidRAW/src/components/panel/SettingsPanel.tsx),
[LensCorrectionModal.tsx](/home/yann/dev/RapidRAW/src/components/modals/LensCorrectionModal.tsx),
[NegativeConversionModal.tsx](/home/yann/dev/RapidRAW/src/components/modals/NegativeConversionModal.tsx),
[TransformModal.tsx](/home/yann/dev/RapidRAW/src/components/modals/TransformModal.tsx).

Critère de sortie:
plus aucun appel IPC “critique” en string brut dans les zones migrées, et types TS stricts compilent.

### 6. Phase 5 — Nettoyage (remove) et normalisation
Actions:
1. Supprimer l’enum `Invokes` dans [AppProperties.tsx](/home/yann/dev/RapidRAW/src/components/ui/AppProperties.tsx#L8) une fois migration frontend complète.
2. Supprimer les imports inutiles `invoke`/`listen` restants quand remplacés par `commands`/`events`.
3. Supprimer les entrées incohérentes historiques:
`invoke_generative_replace`,
`image_processing::generate_waveform`.
4. Supprimer les paths “double contrat” (fallback legacy) une fois validés.
5. Ajouter une vérification CI/lint simple qui échoue si des `invoke('...')`/`listen('...')` non autorisés réapparaissent.

Critère de sortie:
contrat IPC centralisé dans `bindings.ts`, plus de dette legacy active.

### 7. Phase 6 — Validation finale et verrouillage
Actions:
1. Valider builds:
`cargo check`,
`npm run build`,
`npm run lint` (si applicable dans le flux équipe).
2. Vérifier par tests manuels guidés (voir section tests).
3. Vérifier par script de cohérence:
toutes commandes backend exposées dans bindings,
pas de commandes frontend orphelines,
events frontend alignés avec backend.

Critère de sortie:
pipeline vert + checklist fonctionnelle signée.

### 8. Phase 7 — POC final (petit flux démonstrateur)
POC choisi:
migrer le flux “AI connector status” pour montrer commande typée + event typé de bout en bout.

Implémentation POC:
1. Backend:
`check_ai_connector_status` reste la commande de trigger,
event `ai-connector-status-update` devient typé et enregistré dans `collect_events!`.
2. Frontend:
dans [App.tsx](/home/yann/dev/RapidRAW/src/App.tsx#L684),
remplacer `listen('ai-connector-status-update', ...)` par `events.aiConnectorStatusUpdate.listen(...)`,
remplacer `invoke(Invokes.CheckAIConnectorStatus)` par `commands.checkAiConnectorStatus()`.
3. Démo:
au lancement, statut AI se met à jour toutes les 10s avec contrat 100% typé sans string IPC.

Critère de sortie POC:
flux visible fonctionnel, compilé strict TS, aucun `any` nécessaire sur ce flux.

---

## Changements d’API / interfaces publiques (frontend-backend)
1. Nouveau contrat généré [bindings.ts](/home/yann/dev/RapidRAW/src/bindings.ts) exposant `commands` et `events`.
2. Côté frontend, l’API d’appel devient `commands.<camelCase>()` au lieu de `invoke('<snake_case>')`.
3. Côté frontend, l’API event devient `events.<camelCase>.listen(...)` au lieu de `listen('<kebab-case>')`.
4. Gestion d’erreurs maintenue en mode “throw” (`ErrorHandlingMode::Throw`) pour ne pas casser `try/catch`.
5. Migration complète prévue des retours binaires `Response` vers `Vec<u8>` pour typings robustes.

## Liste explicite des suppressions prévues
1. Suppression de `Invokes` dans [AppProperties.tsx](/home/yann/dev/RapidRAW/src/components/ui/AppProperties.tsx).
2. Suppression des constantes invalides `invoke_generative_replace` et `image_processing::generate_waveform`.
3. Suppression des appels `invoke('...')` et `listen('...')` legacy une fois tous migrés.
4. Suppression des handlers/branches de compatibilité temporaires après validation.
5. Suppression des incohérences events non alignées (ou remplacement par émissions backend correspondantes).

## Edge cases couverts explicitement
1. Compatibilité Tauri/Specta: feature `tauri/specta` obligatoire pour masquer `State`, `AppHandle`, `Window` des signatures JS.
2. `serde_json::Value` dans signatures: feature Specta correspondante requise.
3. Retours binaires `Response`: migration vers `Vec<u8>` pour éviter les trous de typing.
4. Contrat erreurs: mode `Throw` imposé pour préserver comportement actuel frontend.
5. Noms events/commands: normalisation snake_case/kebab-case -> camelCase dans bindings.
6. Écarts event payload (string vs object) traités par structs explicites.
7. Événements “oubliés” frontend/backend harmonisés avant finalisation.
8. Régressions cancellation export traitées via event explicite `export-cancelled`.
9. Structures récursives (`FolderNode`) typées et validées.
10. Tuples/Options (`Option<(String, String)>`) vérifiés dans bindings générés.

## Tests et scénarios d’acceptation
1. Build backend: `cd src-tauri && cargo check` doit passer.
2. Build frontend: `npm run build` doit passer sans erreur TS.
3. Smoke test commandes:
chargement image, réglages, export simple, export batch, presets, import, lens tools, negative conversion.
4. Smoke test events:
preview updates, histogram/waveform, thumbnails, import/export progress, denoise/panorama/hdr, indexing.
5. Test contractuel:
aucune commande frontend orpheline, aucun event frontend mort, aucun nom IPC string non migré en zone finalisée.
6. Test POC:
statut AI connector fonctionnel via `commands + events` générés.

## Assumptions et defaults retenus
1. Objectif final: migration complète “tout ce qui est possible” vers contrat typé.
2. Stratégie: progressive, sans big-bang, avec compat temporaire contrôlée.
3. Les 3 commandes binaires sont migrées dans l’intégration complète, mais pas dans le POC initial.
4. Les bindings générés `src/bindings.ts` sont versionnés dans le repo.
5. Le contrat event final est aligné bidirectionnellement, en privilégiant la conservation du comportement UX existant.
