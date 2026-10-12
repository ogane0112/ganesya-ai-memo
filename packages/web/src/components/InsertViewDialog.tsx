import { inlineViewBlock, inlineViewFolder, type ViewType } from '@gmemo/core';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { displayPath } from '../lib/paths';
import { VIEW_TYPES } from '../lib/viewYaml';
import { useApp } from '../state/app';
import { Modal } from './ui';

/**
 * Add a list (table, kanban, calendar) to the note being edited. Inserts the
 * same ```gmemo-view block a person could write by hand, with its own folder
 * under this note, and creates that folder so it shows in the tree.
 */
export function InsertViewDialog({
  open,
  notePath,
  onClose,
  onInsert,
}: {
  open: boolean;
  notePath: string;
  onClose: () => void;
  onInsert: (markdown: string) => void;
}) {
  const { refreshNotes } = useApp();
  const [name, setName] = useState('タスク');
  const [type, setType] = useState<ViewType>('kanban');
  useEffect(() => {
    if (open) {
      setName('タスク');
      setType('kanban');
    }
  }, [open]);
  const folder = inlineViewFolder(notePath, name);

  return (
    <Modal open={open} onClose={onClose} title="一覧を挿入">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const shown = name.trim() || '一覧';
          onInsert(`\n${inlineViewBlock({ name: shown, type, folder })}\n`);
          // An empty folder only shows in the tree once it is created on its own.
          void api
            .createFolder(folder)
            .then(refreshNotes)
            .catch(() => undefined);
        }}
      >
        <div className="field">
          <label htmlFor="iv-name">名前</label>
          <input
            id="iv-name"
            className="input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <span className="label" id="iv-type">
            表示
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="iv-type">
            {VIEW_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={type === t.value}
                onClick={() => setType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="hint">あとから一覧の上のタブでいつでも切り替えられます。</div>
        </div>
        <p className="hint">中のノートの保存先: {displayPath(folder)}</p>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary">
            挿入
          </button>
        </div>
      </form>
    </Modal>
  );
}
