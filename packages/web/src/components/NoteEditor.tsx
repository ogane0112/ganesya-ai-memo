import { parseNoteLenient, serializeNote } from '@gmemo/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { PublicFinding } from '../api/types';
import { useOnline } from '../lib/hooks';
import { loadDraft, saveDraft } from '../lib/queueStore';
import { pendingFor } from '../lib/queue';
import { syncQueue } from '../lib/sync';
import { useToast } from '../state/toast';
import { Editor, type EditorHandle } from './Editor';
import { EditorToolbar } from './EditorToolbar';
import { Icon } from './Icon';
import { FindingList } from './SensitiveConfirm';

interface Props {
  path: string;
  /** Server content; null for a new note. */
  content: string | null;
  sha: string | null;
  commit?: string;
  onDone: () => void;
}

const AUTOSAVE_IDLE_MS = 20_000;

/**
 * Edits one note. Saves go through the offline queue with the blob sha the
 * edit started from, so the server can merge with changes made elsewhere.
 */
export function NoteEditor({ path, content, sha, commit, onDone }: Props) {
  const editor = useRef<EditorHandle>(null);
  const toast = useToast();
  const online = useOnline();
  const pending = pendingFor(syncQueue.snapshot, path);
  const pendingContent = pending?.op.kind === 'save' ? pending.op.content : null;
  const initial = pendingContent ?? content ?? '';
  const baseRef = useRef<string | null | undefined>(
    pending?.op.kind === 'save' ? pending.op.baseSha : sha,
  );
  const savedRef = useRef(initial);
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [scan, setScan] = useState<PublicFinding[] | null>(null);
  const scanDismissed = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = text !== savedRef.current;

  // Offer to restore an unsaved local draft.
  useEffect(() => {
    void loadDraft(path).then((d) => {
      if (d && d.content !== initial && d.content.trim()) setDraft(d.content);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Keep a local draft of every keystroke (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      void saveDraft(
        path,
        dirty
          ? { path, content: text, baseSha: baseRef.current, updatedAt: Date.now() }
          : undefined,
      );
    }, 500);
    return () => clearTimeout(t);
  }, [text, dirty, path]);

  // Tell the server we are editing: concurrent AI writes become proposals instead of direct commits.
  useEffect(() => {
    if (!online) return;
    void api.editing(path, true).catch(() => undefined);
    const iv = setInterval(() => void api.editing(path, true).catch(() => undefined), 30_000);
    return () => {
      clearInterval(iv);
      void api.editing(path, false).catch(() => undefined);
    };
  }, [path, online]);

  const runScan = useCallback(async (saved: string) => {
    if (scanDismissed.current || !navigator.onLine) return;
    try {
      const fm = parseNoteLenient(saved).frontmatter;
      if (fm['sensitivity'] === 'secret') return;
      const r = await api.scanSensitive(saved);
      if (r.suggestSecret && r.findings.length) setScan(r.findings);
    } catch {
      /* the scan is advisory */
    }
  }, []);

  // Results from the queue for this path.
  useEffect(() => {
    return syncQueue.onResult((item, outcome) => {
      if (item.op.kind !== 'save' || item.op.path !== path) return;
      if (outcome.type === 'committed') {
        baseRef.current = outcome.sha;
        void runScan(item.op.content);
      } else if (outcome.type === 'proposed') {
        setProposalId(outcome.proposalId);
      } else if (outcome.type === 'failed') {
        toast.show(`保存できませんでした: ${outcome.error}`, { kind: 'error' });
      }
    });
  }, [path, runScan, toast]);

  const save = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const current = editor.current?.getValue() ?? textRef.current;
      if (current === savedRef.current) return;
      setSaving(true);
      try {
        await syncQueue.enqueue({
          kind: 'save',
          path,
          content: current,
          baseSha: baseRef.current,
          ...(commit ? { baseCommit: commit } : {}),
        });
        savedRef.current = current;
        setText(current);
        void saveDraft(path, undefined);
        if (!opts.quiet)
          toast.show(navigator.onLine ? '保存しました' : '端末に保存しました(オンラインで同期)', {
            kind: 'success',
            duration: 2000,
          });
      } finally {
        setSaving(false);
      }
    },
    [path, commit, toast],
  );

  // Autosave after a pause, when the page is hidden, and when leaving.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save({ quiet: true }), AUTOSAVE_IDLE_MS);
    return () => clearTimeout(t);
  }, [text, dirty, save]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void save({ quiet: true });
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void save({ quiet: true });
    };
  }, [save]);

  const markSecret = async () => {
    const cur = editor.current?.getValue() ?? text;
    const parsed = parseNoteLenient(cur);
    const next = serializeNote({ ...parsed.frontmatter, sensitivity: 'secret' }, parsed.body);
    editor.current?.setValue(next);
    setScan(null);
    scanDismissed.current = true;
    await save();
  };

  const allow = async () => {
    const f = scan ?? [];
    setScan(null);
    scanDismissed.current = true;
    try {
      await Promise.all(
        [...new Set(f.map((x) => x.fingerprint))].map((fp) => api.allowFinding(fp)),
      );
      toast.show('問題なしとして記録しました');
    } catch {
      toast.show('記録できませんでした', { kind: 'error' });
    }
  };

  return (
    <div className="note-editor">
      {draft !== null && (
        <div className="banner banner-warn" role="alert">
          <span>保存していない下書きがこの端末に残っています。</span>
          <span className="row">
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => {
                editor.current?.setValue(draft);
                setDraft(null);
              }}
            >
              復元
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setDraft(null);
                void saveDraft(path, undefined);
              }}
            >
              破棄
            </button>
          </span>
        </div>
      )}
      {proposalId && (
        <div className="banner banner-warn" role="alert">
          <span>
            他の端末やAIの変更と自動で統合できない部分がありました。あなたの編集は提案として保存されています。
          </span>
          <Link
            className="btn btn-small btn-primary"
            to={`/review/${encodeURIComponent(proposalId)}`}
          >
            競合を確認
          </Link>
        </div>
      )}
      {scan && (
        <div className="banner banner-danger" role="alert">
          <div>
            <strong>機密情報らしき内容があります。</strong>このノートを{' '}
            <code>sensitivity: secret</code> にすると、外部AIには送られなくなります。
            <FindingList findings={scan} />
          </div>
          <span className="row wrap">
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => void markSecret()}
            >
              secret にする
            </button>
            <button type="button" className="btn btn-small" onClick={() => void allow()}>
              問題なし
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="閉じる"
              onClick={() => {
                setScan(null);
                scanDismissed.current = true;
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </span>
        </div>
      )}
      <div className="note-editor-head">
        <span className="hint mono ellipsis">{path}</span>
        <span className="hint">
          {saving ? '保存中…' : dirty ? '未保存' : pending ? '同期待ち' : '保存済み'}
        </span>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            void save({ quiet: true })
              .then(() => syncQueue.settled(path))
              .then(onDone);
          }}
        >
          完了
        </button>
      </div>
      <div className="write-editor">
        <Editor
          ref={editor}
          initialValue={initial}
          onChange={setText}
          onSave={() => void save()}
          autoFocus={content === null}
          placeholder="本文を書きましょう"
        />
      </div>
      <EditorToolbar editor={editor} onSave={() => void save()} saving={saving} dirty={dirty} />
    </div>
  );
}
