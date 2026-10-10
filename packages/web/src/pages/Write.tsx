import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Editor, type EditorHandle } from '../components/Editor';
import { EditorToolbar } from '../components/EditorToolbar';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/ui';
import { useDocumentTitle, useOnline } from '../lib/hooks';
import { firstLineTitle, quickNoteContent, timestampTitle, uniquePath } from '../lib/newNote';
import { noteUrl } from '../lib/paths';
import { loadDraft, saveDraft } from '../lib/queueStore';
import { syncQueue } from '../lib/sync';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

const FOLDER_KEY = 'gmemo.quickFolder';
const MODE_KEY = 'gmemo.quickMode';
const DRAFT_KEY = '__quick__';

type Mode = 'note' | 'append';

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The start screen: write first, organize later (AI helps with that). */
export function WritePage() {
  useDocumentTitle('書く');
  const { notes, queue } = useApp();
  const online = useOnline();
  const toast = useToast();
  const navigate = useNavigate();
  const editor = useRef<EditorHandle>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [folder, setFolder] = useState(() => stored(FOLDER_KEY, 'Inbox'));
  const [mode, setMode] = useState<Mode>(() =>
    stored(MODE_KEY, 'note') === 'append' ? 'append' : 'note',
  );
  const [ready, setReady] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore an unsent draft (the app may have been closed mid-sentence).
  useEffect(() => {
    void loadDraft(DRAFT_KEY).then((d) => {
      if (d?.content) {
        try {
          const parsed = JSON.parse(d.content) as { title: string; body: string };
          setTitle(parsed.title ?? '');
          setBody(parsed.body ?? '');
        } catch {
          setBody(d.content);
        }
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void saveDraft(
        DRAFT_KEY,
        title || body
          ? {
              path: DRAFT_KEY,
              content: JSON.stringify({ title, body }),
              baseSha: undefined,
              updatedAt: Date.now(),
            }
          : undefined,
      );
    }, 400);
  }, [title, body, ready]);

  useEffect(() => {
    try {
      localStorage.setItem(FOLDER_KEY, folder);
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [folder, mode]);

  const folders = useMemo(() => {
    const s = new Set<string>(['Inbox']);
    for (const n of notes) {
      const i = n.path.lastIndexOf('/');
      if (i > 0) s.add(n.path.slice(0, i));
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [notes]);

  const clear = () => {
    setTitle('');
    setBody('');
    setEditorKey((k) => k + 1);
    void saveDraft(DRAFT_KEY, undefined);
  };

  const save = async () => {
    const text = editor.current?.getValue() ?? body;
    if (!text.trim() && !title.trim()) {
      editor.current?.focus();
      return;
    }
    if (mode === 'append') {
      await syncQueue.enqueue({
        kind: 'capture',
        text: title.trim() ? `**${title.trim()}** ${text.trim()}` : text.trim(),
        folder: folder.trim() || 'Inbox',
      });
      clear();
      toast.show(
        online
          ? '今日のメモに追記しました'
          : 'オフラインのため端末に保存しました。接続が戻ると追記されます',
        { kind: 'success' },
      );
      return;
    }
    const t = title.trim() || firstLineTitle(text) || timestampTitle();
    const taken = new Set([
      ...notes.map((n) => n.path.toLowerCase()),
      ...queue.items.flatMap((i) => (i.op.kind === 'save' ? [i.op.path.toLowerCase()] : [])),
    ]);
    const path = uniquePath(t, folder.trim(), taken);
    const content = quickNoteContent(title.trim(), text);
    await syncQueue.enqueue({
      kind: 'save',
      path,
      content,
      baseSha: null,
      message: `Quick note ${path}`,
    });
    clear();
    toast.show(
      online ? '保存しました' : 'オフラインのため端末に保存しました。接続が戻ると同期されます',
      {
        kind: 'success',
        action: { label: '開く', onClick: () => navigate(noteUrl(path)) },
      },
    );
  };

  return (
    <div className="write-page">
      <div className="write-head">
        <label className="visually-hidden" htmlFor="quick-title">
          タイトル(省略可)
        </label>
        <input
          id="quick-title"
          className="write-title"
          placeholder="タイトル(省略可)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              editor.current?.focus();
            }
          }}
          enterKeyHint="next"
          autoComplete="off"
        />
        <div className="write-options">
          <Segmented<Mode>
            label="保存のしかた"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'note', label: '新しいノート' },
              { value: 'append', label: '今日のメモに追記' },
            ]}
          />
          <label className="folder-pick">
            <span className="visually-hidden">保存先フォルダ</span>
            <Icon name="folder" size={18} />
            <input
              className="input input-small"
              list="quick-folders"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              aria-label="保存先フォルダ"
            />
            <datalist id="quick-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
        </div>
      </div>
      <div className="write-editor">
        {ready && (
          <Editor
            key={editorKey}
            ref={editor}
            initialValue={body}
            onChange={setBody}
            onSave={() => void save()}
            autoFocus
            placeholder="思いついたことを書きましょう。整理はAIに任せられます。"
          />
        )}
      </div>
      <EditorToolbar
        editor={editor}
        onSave={() => void save()}
        saveLabel={mode === 'append' ? '追記' : '保存'}
        dirty={!!(title || body.trim())}
      />
    </div>
  );
}
