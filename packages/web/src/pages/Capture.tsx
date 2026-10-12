import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FolderPicker } from '../components/FolderPicker';
import { Icon } from '../components/Icon';
import { PageHeader, Spinner } from '../components/ui';
import { useDocumentTitle, useOnline } from '../lib/hooks';
import { folderList, noteUrl } from '../lib/paths';
import { syncQueue } from '../lib/sync';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

/** Share target: text/links shared from other apps land here. */
export function CapturePage() {
  useDocumentTitle('メモに保存');
  const [params] = useSearchParams();
  const sharedText = params.get('text') ?? '';
  // Android often puts the URL into `text`; keep it there if `url` is empty.
  const [title, setTitle] = useState(params.get('title') ?? '');
  const [text, setText] = useState(sharedText);
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [folder, setFolder] = useState('Inbox');
  const { notes, folders: created } = useApp();
  const folders = useMemo(
    () =>
      folderList(
        notes.map((n) => n.path),
        ['Inbox', ...created],
      ),
    [notes, created],
  );
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const toast = useToast();
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() && !url.trim()) return;
    setBusy(true);
    try {
      const body = text.trim() || url.trim();
      await syncQueue.enqueue({
        kind: 'capture',
        text: body,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        ...(url.trim() && url.trim() !== body ? { url: url.trim() } : {}),
      });
      const unsub = syncQueue.onResult((_i, outcome) => {
        if (outcome.type === 'captured') {
          unsub();
          toast.show('保存しました', {
            kind: 'success',
            action: { label: '開く', onClick: () => navigate(noteUrl(outcome.path)) },
          });
        }
      });
      setTimeout(unsub, 15_000);
      if (!online) toast.show('オフラインのため端末に保存しました。接続が戻ると追加されます');
      navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="page" onSubmit={(e) => void submit(e)}>
      <PageHeader title="メモに保存" sub="共有された内容をノートに追加します" />
      <div className="field">
        <label htmlFor="cap-title">タイトル(入力すると新しいノートになります)</label>
        <input
          id="cap-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="cap-text">本文</label>
        <textarea
          id="cap-text"
          className="input textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="cap-url">URL</label>
        <input
          id="cap-url"
          className="input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="field">
        <span className="label">フォルダ</span>
        <FolderPicker
          label="保存先のフォルダー"
          value={folder}
          onChange={setFolder}
          folders={folders}
          allowEmpty={false}
        />
        <div className="hint">タイトルが空なら、このフォルダの「今日のメモ」に追記します。</div>
      </div>
      <button
        type="submit"
        className="btn btn-primary btn-block btn-large"
        disabled={busy || (!text.trim() && !url.trim())}
      >
        {busy ? <Spinner /> : <Icon name="save" />}
        保存
      </button>
    </form>
  );
}
