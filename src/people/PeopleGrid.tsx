import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import FaceThumbnail from './FaceThumbnail';
import PersonShortcutButton from './PersonShortcutButton';
import type { PersonSummary } from './types';

type Props = {
  people: PersonSummary[];
  selected: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onReview: (id: string) => void;
  onMerge: (target: string, ids: string[]) => void;
  shortcutScope: string;
  shortcuts: Map<string, string>;
  editingShortcuts: boolean;
  onShortcutsChanged: () => Promise<void>;
};

const PersonCard = memo(function PersonCard({
  person,
  selected,
  disabled,
  onToggle,
  onOpen,
  onReview,
  shortcutScope,
  shortcut,
  editingShortcuts,
  onShortcutsChanged,
}: Omit<Props, 'people' | 'selected' | 'shortcuts' | 'onMerge'> & {
  person: PersonSummary;
  selected: boolean;
  shortcut: string | null;
}) {
  const { t } = useTranslation();
  const drag = useDraggable({ id: person.id, disabled });
  const drop = useDroppable({ id: person.id, disabled });
  const isTarget = drop.isOver && !drag.isDragging;
  return (
    <div
      ref={drop.setNodeRef}
      className={`relative min-w-0 max-w-44 rounded-md transition-shadow ${isTarget ? 'ring-4 ring-accent bg-surface shadow-lg' : ''}`}
    >
      <div
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        className={`rounded-md touch-none select-none cursor-grab active:cursor-grabbing ${selected ? 'ring-2 ring-blue-500' : ''} ${drag.isDragging ? 'opacity-40' : ''}`}
      >
        <FaceThumbnail
          id={person.representativeFace}
          label={person.name || t('people.unnamed')}
          onOpen={(event) => {
            if (disabled) return;
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              onToggle(person.id);
            } else onOpen(person.id);
          }}
        />
      </div>
      {isTarget && (
        <span className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-md bg-bg-secondary px-3 py-1 text-xs font-medium text-text-primary shadow-md">
          {t('people.merge')}
        </span>
      )}
      <div className="flex items-center gap-1 mt-1">
        <label className="flex items-center justify-center min-w-7 min-h-8 cursor-pointer">
          <input
            type="checkbox"
            aria-label={t('people.select')}
            checked={selected}
            disabled={disabled}
            onChange={() => onToggle(person.id)}
          />
        </label>
        <button
          title={t('people.editPerson')}
          className="text-sm truncate text-left flex-1"
          onClick={() => onReview(person.id)}
        >
          {person.name || t('people.unnamed')}
        </button>
        <span className="text-xs text-text-secondary">{person.photoCount}</span>
        <PersonShortcutButton
          scope={shortcutScope}
          personId={person.id}
          shortcut={shortcut}
          showUnassigned={editingShortcuts}
          onChanged={onShortcutsChanged}
        />
      </div>
      <button className="text-xs p-2 hover:bg-surface rounded-md" onClick={() => onReview(person.id)}>
        {t('people.editPerson')}
      </button>
    </div>
  );
});

export default function PeopleGrid(props: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dragged = useRef<string[]>([]);
  const [preview, setPreview] = useState<{ person: PersonSummary; count: number } | null>(null);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={({ active }) => {
        const id = String(active.id);
        dragged.current = props.selected.includes(id) ? [...props.selected] : [id];
        const person = props.people.find((item) => item.id === id);
        setPreview(person ? { person, count: dragged.current.length } : null);
      }}
      onDragCancel={() => {
        dragged.current = [];
        setPreview(null);
      }}
      onDragEnd={({ active, over }) => {
        const ids = dragged.current;
        dragged.current = [];
        setPreview(null);
        if (!props.disabled && over && over.id !== active.id) props.onMerge(String(over.id), ids);
      }}
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
        {props.people.map((person) => (
          <PersonCard
            key={person.id}
            person={person}
            selected={props.selected.includes(person.id)}
            disabled={props.disabled}
            onToggle={props.onToggle}
            onOpen={props.onOpen}
            onReview={props.onReview}
            shortcutScope={props.shortcutScope}
            shortcut={props.shortcuts.get(person.id) || null}
            editingShortcuts={props.editingShortcuts}
            onShortcutsChanged={props.onShortcutsChanged}
          />
        ))}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null} zIndex={1000}>
          {preview && (
            <div className="pointer-events-none relative translate-x-4 translate-y-4 rotate-3 rounded-md shadow-2xl ring-2 ring-accent cursor-grabbing">
              <FaceThumbnail id={preview.person.representativeFace} />
              {preview.count > 1 && (
                <span className="absolute -top-2 -right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-bg-secondary px-2 text-sm font-semibold text-text-primary shadow-md">
                  {preview.count}
                </span>
              )}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
