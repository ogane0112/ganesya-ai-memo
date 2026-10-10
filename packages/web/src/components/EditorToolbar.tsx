import { type RefObject, useRef, useState } from 'react';
import { api, describeError } from '../api/client';
import { useKeyboardInset, useOnline } from '../lib/hooks';
import { useToast } from '../state/toast';
import type { EditorHandle } from './Editor';
import { Icon } from './Icon';
import { Spinner } from './ui';

/** Big-target formatting bar. On phones it sticks to the bottom, above the keyboard. */
export function EditorToolbar({
  editor,
  onSave,
  saving,
  saveLabel = '保存',
  dirty,
}: {
  editor: RefObject<EditorHandle | null>;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
  dirty?: boolean;
}) {
  const inset = useKeyboardInset();
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const online = useOnline();
  const toast = useToast();

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const r = await api.uploadAttachment(f);
      editor.current?.insert(`${r.markdown}\n`);
    } catch (e) {
      toast.show(`添付できませんでした: ${describeError(e)}`, { kind: 'error' });
    } finally {
      setUploading(false);
    }
  };

  // Keep focus in the editor when tapping toolbar buttons (prevents the keyboard from closing).
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return (
    <div
      className="editor-toolbar"
      role="toolbar"
      aria-label="書式"
      style={inset ? { transform: `translateY(-${inset}px)` } : undefined}
    >
      <div className="editor-toolbar-tools">
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => editor.current?.cycleHeading()}
          aria-label="見出し"
          title="見出し"
        >
          <Icon name="heading" size={22} />
        </button>
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => editor.current?.togglePrefix('- ')}
          aria-label="箇条書き"
          title="箇条書き"
        >
          <Icon name="list" size={22} />
        </button>
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => editor.current?.togglePrefix('- [ ] ')}
          aria-label="チェックリスト"
          title="チェックリスト"
        >
          <Icon name="task" size={22} />
        </button>
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => editor.current?.wrap('[[', ']]')}
          aria-label="ノートへのリンク"
          title="ノートへのリンク [[ ]]"
        >
          <Icon name="link" size={22} />
        </button>
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => file.current?.click()}
          disabled={!online || uploading}
          aria-label="画像やファイルを添付"
          title={online ? '添付' : 'オフライン中は添付できません'}
        >
          {uploading ? <Spinner label="アップロード中" /> : <Icon name="image" size={22} />}
        </button>
        <button
          type="button"
          className="tool"
          onMouseDown={keep}
          onClick={() => editor.current?.undo()}
          aria-label="元に戻す"
          title="元に戻す"
        >
          <Icon name="undo" size={22} />
        </button>
        <button
          type="button"
          className="tool hide-narrow"
          onMouseDown={keep}
          onClick={() => editor.current?.redo()}
          aria-label="やり直し"
          title="やり直し"
        >
          <Icon name="redo" size={22} />
        </button>
        <input
          ref={file}
          type="file"
          hidden
          accept="image/*,application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary tool-save"
        onMouseDown={keep}
        onClick={onSave}
        disabled={saving}
      >
        {saving ? <Spinner label="保存中" /> : <Icon name="check" size={20} />}
        {saveLabel}
        {dirty && <span className="dirty-dot" aria-label="未保存の変更あり" />}
      </button>
    </div>
  );
}
