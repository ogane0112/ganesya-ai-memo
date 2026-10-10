import { useState } from 'react';
import { api, describeError } from '../../api/client';
import type { PasskeyInfo } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, ErrorBox, Loading, SecretReveal, Spinner } from '../../components/ui';
import { deviceName } from '../../lib/device';
import { formatDate, relativeTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { passkeyErrorMessage, registerPasskey } from '../../lib/webauthn';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

export function SecuritySettings() {
  const keys = useAsync(() => api.passkeys(), []);
  const { auth, refreshAuth } = useApp();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState(deviceName());
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await registerPasskey({ name: newName.trim() });
      toast.show('パスキーを追加しました', { kind: 'success' });
      setAdding(false);
      keys.reload();
      void refreshAuth();
    } catch (err) {
      toast.show(passkeyErrorMessage(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!confirm('新しいリカバリーコードを発行しますか?いまのコードはすべて使えなくなります。'))
      return;
    try {
      const r = await api.regenerateRecoveryCodes();
      setCodes(r.codes);
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    }
  };

  const count = keys.data?.length ?? 0;

  return (
    <div className="stack">
      <section className="card">
        <h2>パスキー</h2>
        <p className="hint">パスワードの代わりに、端末の指紋・顔認証・PIN でサインインします。</p>
        {keys.data && count < 2 && (
          <p className="notice notice-warn">
            パスキーが1つだけです。端末をなくすとサインインできなくなるので、スマホとPCなど
            <strong>2台以上</strong>で登録しておくことをおすすめします。
          </p>
        )}
        {keys.loading && !keys.data ? (
          <Loading />
        ) : keys.error ? (
          <ErrorBox error={keys.error} onRetry={keys.reload} />
        ) : null}
        <ul className="item-list">
          {keys.data?.map((k) => (
            <PasskeyRow key={k.id} pk={k} canDelete={count > 1} onChanged={keys.reload} />
          ))}
        </ul>
        {adding ? (
          <form className="inline-form" onSubmit={(e) => void add(e)}>
            <div className="field">
              <label htmlFor="pk-new-name">この端末の名前</label>
              <input
                id="pk-new-name"
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
              />
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                キャンセル
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <Spinner /> : <Icon name="key" size={18} />}
                登録する
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            この端末のパスキーを追加
          </button>
        )}
        <p className="hint">
          別の端末を追加するときは、その端末でこの画面を開いて「追加」してください(ほかの端末から QR
          コードで登録できるブラウザもあります)。
        </p>
      </section>

      <section className="card">
        <h2>リカバリーコード</h2>
        <p className="hint">すべてのパスキーを使えなくなったときのための、1回限りのコードです。</p>
        {auth?.recoveryCodesRemaining != null && (
          <p>
            残り <strong>{auth.recoveryCodesRemaining}</strong> 個
            {auth.recoveryCodesRemaining < 3 && <Badge tone="warn">少なくなっています</Badge>}
          </p>
        )}
        {codes ? (
          <SecretReveal
            title="新しいリカバリーコード"
            lines={codes}
            filename="gmemo-recovery-codes.txt"
            note="この画面を閉じると二度と表示されません。古いコードはもう使えません。"
            onDone={() => {
              setCodes(null);
              void refreshAuth();
            }}
          />
        ) : (
          <button type="button" className="btn" onClick={() => void regenerate()}>
            新しいコードを発行
          </button>
        )}
      </section>
    </div>
  );
}

function PasskeyRow({
  pk,
  canDelete,
  onChanged,
}: {
  pk: PasskeyInfo;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pk.name);
  const toast = useToast();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.renamePasskey(pk.id, name);
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    }
  };
  const remove = async () => {
    if (!confirm(`パスキー「${pk.name}」を削除しますか?この端末ではサインインできなくなります。`))
      return;
    try {
      await api.deletePasskey(pk.id);
      onChanged();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    }
  };
  return (
    <li className="item">
      {editing ? (
        <form className="row grow" onSubmit={(e) => void save(e)}>
          <label className="visually-hidden" htmlFor={`pk-${pk.id}`}>
            パスキーの名前
          </label>
          <input
            id={`pk-${pk.id}`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={60}
          />
          <button type="submit" className="btn btn-small btn-primary">
            保存
          </button>
          <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      ) : (
        <>
          <div className="item-main">
            <strong>
              <Icon name="key" size={16} /> {pk.name}
            </strong>
            <span className="hint">
              登録 {formatDate(pk.createdAt)} ・最終使用{' '}
              {pk.lastUsedAt ? relativeTime(pk.lastUsedAt) : 'なし'}
              {pk.backedUp && ' ・同期済み'}
            </span>
          </div>
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
              名前を変更
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger-text"
              onClick={() => void remove()}
              disabled={!canDelete}
              title={canDelete ? undefined : '最後のパスキーは削除できません'}
            >
              削除
            </button>
          </div>
        </>
      )}
    </li>
  );
}
