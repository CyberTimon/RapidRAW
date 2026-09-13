import type { CommandId } from './definitions';
export type CommandContext = 'library' | 'editor' | 'crop' | 'mask' | 'people' | 'global';
const global = new Set([
  'gallery',
  'develop',
  'open_settings',
  'shortcut_help',
  'go_back',
  'toggle_side_panels',
  'toggle_all_panels',
  'toggle_left_panel',
  'toggle_right_panel',
  'open_folder',
]);
const library = new Set([
  'open_image',
  'focus_search',
  'copy_files',
  'paste_files',
  'toggle_library_exif',
  'open_people',
  'create_folder',
  'create_album',
  'open_panorama',
  'open_hdr',
  'open_focus_stack',
  'import_photos',
  'rename_photos',
  'refresh_library',
  'open_culling',
  'create_virtual_copy',
  'reveal_photo',
  'deselect_all',
  'select_active',
  'extend_prev',
  'extend_next',
]);
export function commandContext(action: CommandId): CommandContext {
  if (action.startsWith('crop_')) return 'crop';
  if (action.startsWith('brush_') || action.startsWith('mask_')) return 'mask';
  if (global.has(action)) return 'global';
  if (action.startsWith('library_') || library.has(action)) return 'library';
  return 'editor';
}

const photoCommands = new Set<CommandId>([
  'copy_adjustments',
  'paste_adjustments',
  'sync_adjustments',
  'select_all',
  'delete_selected',
  'copy_image_path',
  'rotate_left',
  'rotate_right',
  'toggle_export',
  'toggle_crop_panel',
  'toggle_adjustments',
  'toggle_presets',
  'toggle_metadata',
  'toggle_folder_tree',
  'auto_lens',
  'open_denoise',
  'open_negative',
  'open_collage',
  'reset_adjustments',
  'rating_up',
  'rating_down',
]);
export function supportsLibrary(action: CommandId) {
  return photoCommands.has(action) || action.startsWith('rate_') || action.startsWith('color_label_');
}
