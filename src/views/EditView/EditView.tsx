import { LayoutRenderer } from '../../layouts/LayoutRenderer.js';
import { editLayout } from '../../config/layouts/edit.js';
import { renderModule } from '../../modules/registry.js';

export function EditView() {
  return (
    <div className="h-full w-full bg-bg-primary">
      <LayoutRenderer config={editLayout} moduleRenderer={renderModule} />
    </div>
  );
}
