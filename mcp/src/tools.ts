import * as z from 'zod/v4';

const path = z
  .string()
  .min(1)
  .max(32768)
  .describe(
    'Absolute local filesystem path. Exports must be inside workspace/exports; saved recipes must be inside workspace/recipes.',
  );
const record = z.record(z.string(), z.unknown());
const sessionId = z.string().min(1).max(128).describe('Session ID returned by rapidraw_open_photo or rapidraw_merge.');
const session = { session_id: sessionId };
const mutation = {
  ...session,
  expected_revision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Reject the mutation if the session revision changed since inspection.'),
};
const percent = z.number().min(0).max(100);
const region = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict()
  .describe('Rectangle in oriented full-resolution image pixels, before user crop.');
const renderRegion = region
  .extend({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .describe(
    'Rectangle in full-resolution rendered image pixels AFTER user crop and geometry. Extracted before long_edge resizing; read rendered dimensions first.',
  );
const point = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).strict();
const mappedPoint = z.object({ x: z.number(), y: z.number() }).strict();
const longEdge = z
  .number()
  .int()
  .min(1)
  .max(32768)
  .describe('Maximum output long edge in pixels. Preview default 1600; use a region for native detail review.');
const adjustments = record.describe(
  'Native RapidRAW adjustment object. Read needed schemas with capabilities(schema_paths) first; unknown keys and invalid values are rejected. Asset descriptors from session summaries cannot be used as recipes.',
);
const subMask = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    visible: z.boolean(),
    invert: z.boolean().optional(),
    opacity: percent.optional(),
    mode: z.enum(['additive', 'subtractive', 'intersect']),
    parameters: record,
  })
  .strict();
const generationOptions = z
  .object({
    seed: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .optional(),
    megapixels: z.number().min(0.0625).max(16).optional(),
  })
  .strict()
  .describe(
    'Optional reproducible settings for generative mode with an AI Connector. Explicit options require protocol-v2 capabilities and an advertised profile/resolution. Saved with the patch; omit to retain connector defaults.',
  );
const watermark = z
  .object({
    path,
    anchor: z.enum([
      'topLeft',
      'topCenter',
      'topRight',
      'centerLeft',
      'center',
      'centerRight',
      'bottomLeft',
      'bottomCenter',
      'bottomRight',
    ]),
    scale: z.number().positive(),
    spacing: z.number().nonnegative(),
    opacity: percent,
  })
  .strict();
const exportOptions = {
  format: z.enum(['jpeg', 'png', 'tiff', 'webp', 'avif', 'jxl', 'cube']).optional(),
  color_profile: z
    .enum(['auto', 'srgb', 'none'])
    .optional()
    .describe(
      'auto embeds an sRGB ICC profile in JPEG/PNG/TIFF/WebP; srgb requires support; none omits explicit embedding.',
    ),
  quality: z.number().int().min(1).max(100).optional(),
  long_edge: longEdge.optional().describe('Convenience maximum long-edge resize. Cannot be combined with resize.'),
  resize: z
    .object({
      mode: z.enum(['longEdge', 'shortEdge', 'width', 'height']),
      value: z.number().int().min(1).max(32768),
      dont_enlarge: z.boolean().default(true),
    })
    .strict()
    .optional()
    .describe(
      'Resize by long edge, short edge, width or height. Cannot be combined with long_edge; enlargement is disabled by default.',
    ),
  bit_depth: z.union([z.literal(8), z.literal(16)]).optional(),
  keep_metadata: z
    .boolean()
    .optional()
    .describe(
      'Retain capture metadata in JPEG/PNG/WebP from non-TIFF sources. Unsupported requests fail; color_profile controls ICC separately.',
    ),
  strip_gps: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  preserve_timestamps: z.boolean().optional(),
  watermark: watermark.optional(),
  export_masks: z.boolean().optional(),
};
const comparisonOptions = { region: renderRegion.optional(), long_edge: z.number().int().min(1).max(2048).optional() };
const disabledMasks = z.array(z.string().min(1)).max(32);
const variant = z
  .object({
    label: z.string().trim().min(1).max(200),
    version_id: z.uuid().optional(),
    patch: adjustments.optional(),
    disabled_masks: disabledMasks.optional(),
  })
  .strict();
const job = { job_id: z.uuid() };
const enhancementRequest = z
  .object({
    operation: z.enum(['refine_mask', 'semantic_mask', 'deblur', 'upscale']),
    profile: z.enum(['fast', 'balanced', 'quality']).optional(),
    provider: z.enum(['auto', 'cpu', 'coreml', 'cuda']).optional(),
    domain: z.enum(['landscape', 'face']).optional(),
    classes: z.array(z.string().min(1).max(80)).max(32).optional(),
    strength: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    boundary_radius: z.number().int().min(1).max(256).optional(),
    region: z
      .tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().positive(),
        z.number().int().positive(),
      ])
      .optional()
      .describe(
        '[x,y,width,height]. Masks use the oriented canvas before crop. Restoration uses rendered pixels after crop and returns only this region when supplied.',
      ),
  })
  .strict();
export interface ToolDefinition {
  method: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  idempotent?: boolean;
  network?: boolean;
  timeoutMs?: number;
  host?: boolean;
}
function tool(
  method: string,
  description: string,
  shape: z.ZodRawShape,
  readOnly = false,
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return { method, description, schema: z.object(shape).strict(), readOnly, ...extra };
}
export const toolDefinitions: ToolDefinition[] = [
  tool(
    'enhancement_models',
    'Inspect local matting, scene/face parsing, deblur and 2x reconstruction models, installation status and runtime policy.',
    {},
    true,
  ),
  tool(
    'install_enhancement_model',
    'Install a verified local enhancement model. Matting and face models can download; landscape/deblur/upscale use the repository exporter and require its ONNX path and SHA-256. No photographs are uploaded.',
    {
      model_id: z.enum(['matting', 'face', 'landscape', 'deblur', 'upscale']),
      path: path.optional(),
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    },
    false,
    { network: true, timeoutMs: 1_800_000 },
  ),
  tool(
    'enhance',
    'Run native learned mask refinement, semantic selection, deblur or 2x reconstruction. Prefer start_operation for cancellable work. Refinement replaces one mask component preserving siblings and grade. Restoration processes rendered sRGB into a separate session with edits baked; the parent remains editable. Fast/balanced matting limits inference resolution; quality processes native boundary tiles. Review actual detail, receipt timings and enhancement.warnings; partial refinement can retain coarse coverage.',
    {
      session_id: sessionId,
      expected_revision: z.number().int().nonnegative(),
      request: enhancementRequest,
      mask_id: z.string().min(1).optional(),
      sub_mask_id: z.string().min(1).optional(),
      name: z.string().min(1).max(200).optional(),
    },
    false,
    { timeoutMs: 1_800_000 },
  ),
  tool(
    'manage_presets',
    'Manage workspace-owned presets without modifying the desktop library: list, save current edits, import, export or remove. On save, adjustment_keys selects only the intended controls; omit adjustment_keys for the existing full save behavior. Saved masks and geometry are explicit options; LUT dependencies are portable.',
    {
      action: z.enum(['list', 'save', 'import', 'export', 'remove']),
      session_id: sessionId.optional(),
      expected_revision: z.number().int().nonnegative().optional(),
      name: z.string().min(1).max(200).optional(),
      id: z.string().min(1).optional(),
      path: path.optional(),
      include_masks: z.boolean().optional(),
      include_geometry: z.boolean().optional(),
      adjustment_keys: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(100)
        .refine((keys) => new Set(keys).size === keys.length, 'Adjustment keys must be unique')
        .optional()
        .describe(
          'Save only these exact top-level keys from the native adjustment schema. Masks/geometry require their include option. Select lutPath, lutIntensity and lutIsSceneReferred together for LUTs; include curves with any UI curve controls. Omit exposure, temperature, tint and detail keys to preserve per-photo corrections when applied.',
        ),
    },
  ),
  tool(
    'manage_luts',
    'List, import, export or remove workspace-owned LUT assets. Imported files are parsed and copied; removal never deletes desktop or source files.',
    {
      action: z.enum(['list', 'import', 'export', 'remove']),
      name: z.string().min(1).max(200).optional(),
      id: z.string().min(1).optional(),
      path: path.optional(),
    },
  ),
  tool(
    'fork_session',
    'Create an independent candidate from current edits or a named version, preserving derived RAW interpretation and owned assets.',
    { ...mutation, version_id: z.uuid().optional(), label: z.string().trim().min(1).max(200).optional() },
  ),
  tool(
    'export_session_bundle',
    'Save a portable, hash-verified directory bundle containing source, edits, versions and owned assets. Returns a path under workspace/bundles.',
    { ...mutation, name: z.string().min(1).max(120).optional() },
  ),
  tool(
    'import_session_bundle',
    'Validate a portable bundle and import it as a new isolated session. Rejects unsafe paths, missing/corrupt assets and invalid state.',
    {
      path,
      expected_manifest_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
  ),
  tool(
    'diff_versions',
    'Describe adjustment, mask, metadata and asset changes between named references; omit a side to use current edits. Does not mutate history.',
    { ...session, from_version_id: z.uuid().optional(), to_version_id: z.uuid().optional() },
    true,
  ),
  tool(
    'copy_adjustments',
    'Copy explicitly selected adjustment keys to target sessions with per-target revision checks and outcomes. Geometry-dependent controls require equal source dimensions or explicit exclusion.',
    {
      ...mutation,
      version_id: z.uuid().optional(),
      keys: z.array(z.string().min(1)).min(1).max(100),
      geometry: z.enum(['exclude', 'require_same_dimensions']),
      targets: z
        .array(z.object({ session_id: sessionId, expected_revision: z.number().int().nonnegative() }).strict())
        .min(1)
        .max(100),
      mode: z.enum(['merge', 'replace_selected']).optional(),
    },
  ),
  tool(
    'map_coordinates',
    'Map points, strokes and region boundaries between the loaded oriented source, pre-crop mask canvas, rendered image and a specified preview. Reports unmappable points; do not guess geometry from preview scale alone.',
    {
      ...session,
      from: z.enum(['oriented_source', 'mask', 'rendered', 'preview']),
      to: z.enum(['oriented_source', 'mask', 'rendered', 'preview']),
      points: z.array(mappedPoint).max(4096).optional(),
      strokes: z.array(z.array(mappedPoint).max(4096)).max(100).optional(),
      regions: z.array(region).max(100).optional(),
      preview: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          region: renderRegion.optional(),
        })
        .strict()
        .optional(),
    },
    true,
  ),
  tool(
    'preflight',
    'Check source dimensions, native GPU limits, model availability and output compatibility before expensive processing. Estimates are advisory and do not claim photographic quality.',
    {
      ...session,
      operation: z.enum(['render', 'export', 'denoise', 'mask_generate', 'retouch', 'merge']).optional(),
      keep_metadata: z.boolean().optional(),
      format: exportOptions.format,
      bit_depth: exportOptions.bit_depth,
      model_kind: z.enum(['masks', 'inpaint', 'denoise']).optional(),
    },
    true,
  ),
  tool(
    'sample_region',
    'Measure robust rendered RGB and luminance in an exact region, labelled original or edited sRGB. Optional neutral-patch white-balance suggestion never applies an edit or claims sensor RAW measurements.',
    {
      ...session,
      region: renderRegion,
      stage: z.enum(['edited', 'original']).optional(),
      suggest_white_balance: z.boolean().optional(),
    },
    true,
  ),
  tool(
    'start_operation',
    'Capture an immutable input and start merge, export, negative conversion, AI masking/depth, enhancement or local retouch in an independent native worker. Returns job_id. Editing remains available; cancellation stops only this worker.',
    {
      operation: z.enum([
        'merge',
        'export',
        'negative_convert',
        'mask_generate',
        'generate_depth',
        'retouch',
        'enhance',
      ]),
      arguments: record,
    },
    false,
    { host: true },
  ),
  tool(
    'get_operation_job',
    'Inspect a background operation status, stage, error and durable result. No automatic replay after interruption.',
    job,
    true,
    { host: true },
  ),
  tool(
    'list_operation_jobs',
    'List durable background operation records including interrupted jobs after reconnect.',
    {},
    true,
    { host: true },
  ),
  tool(
    'cancel_operation_job',
    'Cancel a background operation by terminating its isolated worker; preserve captured inputs and keep the main editing engine running.',
    job,
    false,
    { host: true, idempotent: true },
  ),
  tool(
    'resume_operation_job',
    'Explicitly restart failed, cancelled or interrupted captured work in a fresh worker workspace. Does not resume partial native computation.',
    job,
    false,
    { host: true },
  ),
  tool(
    'inspect_adjustments',
    'Inspect aligned before/after previews, an actual rendered RGB difference and a combined local exposure map with row statistics. By default disable every enabled mask for the before view. Exposure influence excludes other tonal controls; inspect the actual difference too. Does not change the edit.',
    {
      ...session,
      ...comparisonOptions,
      disabled_masks: disabledMasks.optional(),
      difference_gain: z.number().min(1).max(16).optional(),
      exposure_range: z.number().min(0.01).max(20).optional(),
    },
    true,
  ),
  tool(
    'render_compare',
    'Render 2–4 labeled temporary alternatives with the same crop and output size. Each starts from current edits or a named version, then applies a patch and optional mask disabling. Rejects geometry changes. Never modifies saved edits, history or revision.',
    { ...session, ...comparisonOptions, variants: z.array(variant).min(2).max(4) },
    true,
  ),
  tool(
    'save_version',
    'Save an immutable named reference to the current edits and metadata. Survives undo-history truncation and engine restart. Returns version_id without changing session revision.',
    { ...mutation, label: z.string().trim().min(1).max(200) },
  ),
  tool('list_versions', 'List this session’s named reference versions and their captured revisions.', session, true),
  tool(
    'restore_version',
    'Restore a named version as a new undoable edit, increasing the current revision. Does not overwrite the saved reference.',
    { ...mutation, version_id: z.uuid() },
  ),
  tool(
    'start_denoise',
    'Start background denoise with captured source and edits. ai (default) is lightweight NIND; bm3d is native CPU; nonlocal is Bayer RAW-to-RAW using the provider-selected installed bundle (RAPIDRAW_NONLOCAL_BUNDLE override when set) with native ONNX on CPU or Linux CUDA, or direct CoreML.framework on macOS. Use install_model kind=nonlocal first when the bundle is absent; start_denoise never downloads. Nonlocal creates a float Bayer DNG developed by the normal RAW pipeline; quality balanced uses one pass, maximum four rotations. Intensity defaults to 100 for nonlocal, 50 otherwise. Returns job_id; get_job yields result_session_id. One worker per workspace; editing remains available. Original session is preserved.',
    {
      ...mutation,
      intensity: percent.optional(),
      method: z.enum(['ai', 'bm3d', 'nonlocal']).optional(),
      quality: z.enum(['balanced', 'maximum']).optional(),
    },
  ),
  tool(
    'get_job',
    'Read denoise job progress, status, failure and durable result session. Completed results persist even if never polled. Interrupted jobs can restart from captured input with resume_job.',
    job,
    true,
  ),
  tool(
    'list_jobs',
    'List denoise jobs, including completed and interrupted jobs recovered after an engine restart.',
    {},
    true,
  ),
  tool(
    'cancel_job',
    'Cancel a denoise job without stopping the editing engine. BM3D, NIND and Nonlocal stop between patches or tiles. Poll until cancelled. If completion already won the race, returns the completed result.',
    job,
    false,
    { idempotent: true },
  ),
  tool(
    'resume_job',
    'Restart an interrupted, failed or cancelled denoise job from its captured source and edits. Preserves job_id, increments attempt, and starts computation again; partial work is not a tile checkpoint.',
    job,
  ),
  tool(
    'capabilities',
    'Inspect engine version, methods, coordinates and limitations. Prefer detail:overview before editing, then request only needed schema_paths. No arguments retains the full schema for compatibility.',
    {
      detail: z.enum(['overview', 'full']).optional(),
      schema_paths: z
        .array(z.string().min(1).max(256))
        .min(1)
        .max(32)
        .optional()
        .describe(
          'Dot paths inside adjustment_schema, e.g. properties.temperature or properties.masks. Returns schemas keyed by path, with coordinate rules and schema_id. Reuse until schema_id changes.',
        ),
    },
    true,
  ),
  tool(
    'list_images',
    'Discover supported local images with pagination. Reads source folders without changing images.',
    {
      path,
      recursive: z.boolean().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    true,
  ),
  tool(
    'open_photo',
    'Create an isolated nondestructive editing session from a source image and optional existing sidecar. Returns session_id, revision and dimensions; source files remain unchanged.',
    { path, inherit_sidecar: z.boolean().optional() },
  ),
  tool(
    'list_sessions',
    'List editing sessions in the workspace, including saved sessions available after restart.',
    {},
    true,
  ),
  tool(
    'get_session',
    'Inspect source/working paths, revision, dimensions and optional adjustments. Opaque pixels/tensors default to asset descriptors; preserve complete recipes through native save/bundle tools or explicit include_assets.',
    {
      ...session,
      include_adjustments: z.boolean().optional(),
      include_assets: z
        .boolean()
        .optional()
        .describe(
          'Programmatic full-state reads only: return encoded assets when include_adjustments:true. Omit for visual editing; prefer native save/bundle files for complete recipes. Subject to the response-size budget.',
        ),
    },
    true,
  ),
  tool(
    'close_session',
    'Release a session from memory while preserving its saved manifest. It becomes available on the next bridge startup; save_session also writes a native .rrdata sidecar.',
    session,
  ),
  tool(
    'set_adjustments',
    'Validate and apply a native adjustment patch. Merge preserves unrelated edits; replace supplies a complete new recipe. Returns the new revision.',
    { ...mutation, patch: adjustments, mode: z.enum(['merge', 'replace']).optional() },
  ),
  tool(
    'render',
    'Render a visual preview, original comparison, native detail region, or mask. Returns an MCP image block plus dimensions and revision. Inspect pixels before accepting an edit.',
    {
      ...session,
      long_edge: longEdge.optional(),
      region: renderRegion.optional(),
      format: z.enum(['jpeg', 'png']).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      original: z.boolean().optional(),
      mask_mode: z.enum(['grayscale', 'overlay']).optional(),
      overlay_opacity: z.number().min(0).max(1).optional(),
      clipping_overlay: z.boolean().optional(),
      cache: z.boolean().optional(),
      mask_id: z
        .string()
        .optional()
        .describe('Render this mask as grayscale with numerical coverage, for edge inspection.'),
    },
    true,
  ),
  tool(
    'analyze',
    'Measure rendered exposure, clipping, histogram and optional scopes for the whole image or a detail region. Statistics complement visual review; they do not score artistic quality.',
    {
      ...session,
      long_edge: longEdge.optional(),
      region: renderRegion.optional(),
      histogram: z.boolean().optional(),
      scopes: z.boolean().optional(),
    },
    true,
  ),
  tool(
    'auto_adjust',
    'Compute RapidRAW automatic tonal/color adjustments; apply only when apply=true. Review the suggested or applied result visually.',
    { ...mutation, apply: z.boolean().optional() },
  ),
  tool(
    'mask_create',
    'Create a selective adjustment mask using native geometric, brush, color or luminance parameters. Read parameter schemas from capabilities, then render mask_id to inspect edges.',
    {
      ...mutation,
      name: z.string().max(200).optional(),
      type: z.enum(['radial', 'linear', 'brush', 'flow', 'color', 'luminance', 'all']),
      parameters: record,
      adjustments: adjustments.optional(),
      invert: z.boolean().optional(),
      opacity: percent.optional(),
    },
  ),
  tool(
    'mask_duplicate',
    'Copy a parent mask and its native selection assets into an independently editable mask with fresh IDs. By default, clear its local adjustments; invert=true toggles the copied parent selection.',
    {
      ...mutation,
      mask_id: z.string().min(1).max(128),
      name: z.string().max(200).optional(),
      invert: z.boolean().optional(),
      copy_adjustments: z.boolean().optional(),
    },
  ),
  tool(
    'mask_update',
    'Patch an existing mask or edit individual submasks atomically. Native validation rejects malformed masks; use current revision.',
    {
      ...mutation,
      mask_id: z.string().min(1),
      patch: record.optional(),
      submask_operations: z.array(record).min(1).max(100).optional(),
    },
  ),
  tool('mask_remove', 'Remove a mask from the session, with undo support; original photo is unchanged.', {
    ...mutation,
    mask_id: z.string().min(1),
  }),
  tool(
    'mask_generate',
    'Generate an AI mask. Set target_mask_id and mode to add a new component inside an existing parent; omit both to create a parent. Normals/albedo explicitly use the separately enabled shared AI connector and save RGB16 maps. Normals parameters: normalAngle (degrees), normalAmount (signed exposure stops, -1.5..1.5). Albedo parameters: surfacePointX/Y (0..1 on the unrotated map), surfaceTolerance (.005..1), surfaceColor (RGB 0..255), surfaceAmount (0..1). Saved maps work offline; intersect with regional masks to confine edits. Depth defaults to the built-in model; depth_provider=marigold explicitly sends analysis pixels to the separately enabled depth service and saves a reusable 16-bit map. Subject include/exclude points use the full mask canvas before crop. New point-guided masks require a region or positive point. refine replaces only an existing AI-subject submask, preserving IDs, siblings and grade; requires expected_revision. Inspect returned refinement.prior_mode and review the mask before edits.',
    {
      ...mutation,
      kind: z.enum(['subject', 'foreground', 'sky', 'depth', 'normals', 'albedo']),
      depth_provider: z.enum(['builtin', 'marigold']).optional(),
      name: z.string().max(200).optional(),
      region: region.optional(),
      include_points: z
        .array(point)
        .max(64)
        .optional()
        .describe('Subject points to include; at most 64 include/exclude points combined.'),
      exclude_points: z
        .array(point)
        .max(64)
        .optional()
        .describe('Subject points to exclude; exclude-only refinement requires an existing prior mask.'),
      refine: z
        .object({ mask_id: z.string().min(1).max(128), sub_mask_id: z.string().min(1).max(128).optional() })
        .strict()
        .optional()
        .describe(
          'Update the named ai-subject submask; omit sub_mask_id only when exactly one subject submask exists.',
        ),
      target_mask_id: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('Existing parent to receive a new AI component; cannot be combined with refine.'),
      mode: z
        .enum(['additive', 'subtractive', 'intersect'])
        .optional()
        .describe('Required with target_mask_id; the new component is appended in this composition mode.'),
      parameters: record.optional(),
      adjustments: adjustments.optional(),
    },
    false,
    { network: true },
  ),
  tool('generate_depth', 'Generate an image depth map; optionally enable depth blur. Requires local mask models.', {
    ...mutation,
    enable_blur: z.boolean().optional(),
  }),
  tool(
    'retouch',
    'Apply a reversible clone, heal, retouch, liquify, local inpaint or remote generative patch defined by native submasks. Generative mode sends image content to the configured provider only when explicitly selected; token is used only for that request.',
    {
      ...mutation,
      mode: z.enum(['clone', 'heal', 'retouch', 'liquify', 'inpaint', 'generative']),
      name: z.string().max(200).optional(),
      sub_masks: z.array(subMask).min(1).max(64),
      source_point: point.optional(),
      prompt: z
        .string()
        .max(10000)
        .optional()
        .describe(
          'Required for generative edits; omit for the qwen21-remove-v1 workflow, which supplies a general removal instruction.',
        ),
      token: z.string().max(4096).optional(),
      generation_options: generationOptions.optional(),
      removal_options: z
        .object({
          expandPixels: z.number().int().min(0).max(256).optional(),
          featherPixels: z.number().int().min(0).max(256).optional(),
        })
        .strict()
        .optional()
        .describe(
          'Native inpaint/generative mask controls in source pixels. Nonzero values expand the >=50% core and feather outward; subtractive/intersection components constrain the final mask.',
        ),
      preview_only: z
        .boolean()
        .optional()
        .describe(
          'Inpaint/generative only: return the effective mask without generation, model downloads, or a session edit.',
        ),
    },
    false,
    { network: true },
  ),
  tool(
    'denoise',
    'Synchronous compatibility operation; prefer start_denoise for cancellable background work. Apply native AI or BM3D denoise with a source-preserving intensity blend; intensity 0 is a no-op. The original remains intact. Inspect native detail for lost texture and save the MCP session to preserve linear RAW interpretation after AI denoise.',
    { ...mutation, intensity: percent.optional(), method: z.enum(['ai', 'bm3d']).optional() },
  ),
  tool(
    'lens_profile',
    'Find or automatically apply native lens correction data. Lookup mode inspects profiles; auto mode applies corrections with revision tracking.',
    {
      ...mutation,
      mode: z.enum(['auto', 'lookup']).optional(),
      maker: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      focal_length: z.number().positive().optional(),
      aperture: z.number().positive().optional(),
      distance: z.number().positive().optional(),
    },
  ),
  tool('history', 'Read edit history and current undo/redo position.', session, true),
  tool('undo', 'Undo one session edit and return the restored state/revision.', mutation),
  tool('redo', 'Reapply one undone session edit and return the restored state/revision.', mutation),
  tool(
    'save_session',
    'Persist current session and native .rrdata sidecar inside the workspace for recovery and continued editing.',
    session,
    false,
    { idempotent: true },
  ),
  tool('load_recipe', 'Load and validate a saved adjustment JSON recipe, then merge or replace session edits.', {
    ...mutation,
    path,
    mode: z.enum(['merge', 'replace']).optional(),
  }),
  tool('save_recipe', 'Save a reproducible adjustment JSON recipe under workspace/recipes; returns its path.', {
    ...session,
    path: path.optional(),
  }),
  tool('list_presets', 'List installed RapidRAW edit presets and their identifiers.', {}, true),
  tool('apply_preset', 'Apply an installed native edit preset with an optional intensity.', {
    ...mutation,
    preset_id: z.string().min(1),
    intensity: percent.optional(),
  }),
  tool('list_luts', 'List installed color LUTs and their local paths.', {}, true),
  tool('apply_lut', 'Apply a local LUT at the given intensity using the native renderer.', {
    ...mutation,
    path,
    intensity: percent.optional(),
  }),
  tool(
    'models',
    'Inspect local model installation and availability before AI mask, inpaint or denoise operations.',
    {},
    true,
  ),
  tool(
    'install_model',
    'Download and install RapidRAW local model assets for masks, inpainting, denoise or nonlocal (Bayer RAW denoise runtime bundle selected by RAPIDRAW_NONLOCAL_PROVIDER). This makes network requests and may download large files.',
    { kind: z.enum(['masks', 'inpaint', 'denoise', 'nonlocal']) },
    false,
    { network: true, idempotent: true, timeoutMs: 1_800_000 },
  ),
  tool(
    'export',
    'Export a verified image or LUT under workspace/exports. Source overwrite is forbidden; overwrite defaults false, GPS stripping defaults true. Returns path, dimensions, size and output details.',
    { ...session, path, ...exportOptions },
  ),
  tool(
    'batch_export',
    'Export multiple existing sessions with shared settings. Inspect per-item outcomes; a partial failure is not a successful whole batch.',
    {
      items: z
        .array(z.object({ ...session, path }).strict())
        .min(1)
        .max(100),
      options: z.object(exportOptions).strict().optional(),
    },
    false,
    { timeoutMs: 1_800_000 },
  ),
  tool(
    'merge',
    'Merge multiple source exposures into HDR, focus stack or panorama in a new isolated session. Original images are preserved. Panorama requires every supplied image to connect through reliable matches; disconnected inputs fail instead of producing a partial result.',
    { kind: z.enum(['hdr', 'focus', 'panorama']), paths: z.array(path).min(2).max(100) },
    false,
    { timeoutMs: 1_800_000 },
  ),
  tool(
    'negative_convert',
    'Apply native film-negative conversion to the isolated session using validated conversion parameters.',
    { ...mutation, parameters: record },
  ),
  tool('get_metadata', 'Read session rating, tags and available EXIF metadata.', session, true),
  tool(
    'set_metadata',
    'Update rating, tags or EXIF metadata in the isolated session only. Save/export to persist the changes.',
    {
      ...mutation,
      rating: z.number().int().min(0).max(5).optional(),
      tags: z.array(z.string().max(200)).max(200).optional(),
      exif: z.record(z.string(), z.string()).optional(),
    },
  ),
  tool(
    'get_engine_settings',
    'Inspect effective native color management, processing and AI settings without changing application preferences.',
    {},
    true,
  ),
];
