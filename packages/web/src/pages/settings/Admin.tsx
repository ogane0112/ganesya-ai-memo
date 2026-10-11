import { useState } from 'react';
import { api, describeError } from '../../api/client';
import { Badge, CopyButton, ErrorBox, Loading, SecretReveal, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

const SIGNUP_LABEL = {
  open: '誰でも登録できます',
  invite: '招待コードを持つ人だけ登録できます',
  closed: '新規登録は停止中です',
} as const;

function fmt(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
}

/** Server administration: accounts and invitations (admin account only). */
export function AdminSettings() {
  const toast = useToast();
  const { auth } = useApp();
  const users = useAsync(() => api.users(), []);
  const invites = useAsync(() => api.invites(), []);
  const [newInvite, setNewInvite] = useState<{ url: string; code: string } | null>(null);
  const [resetCodes, setResetCodes] = useState<{ username: string; codes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  if (users.loading && !users.data) return <Loading />;
  if (users.error) return <ErrorBox error={users.error} onRetry={users.reload} />;
  const { users: list, signup } = users.data!;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (resetCodes)
    return (
      <section className="card">
        <SecretReveal
          title={`${resetCodes.username} さんの新しいリカバリーコード`}
          lines={resetCodes.codes}
          note="本人に直接(対面や安全な手段で)渡してください。ユーザー名とコードでログインし、新しいパスキーを登録できます。"
          onDone={() => setResetCodes(null)}
          doneLabel="渡しました"
        />
      </section>
    );

  return (
    <div className="stack">
      <section className="card">
        <h2>アカウント</h2>
        <p className="hint">
          登録方法: {SIGNUP_LABEL[signup]}(サーバー設定 <code>GMEMO_SIGNUP</code> で変更)
        </p>
        <ul className="item-list">
          {list.map((u) => (
            <li key={u.id} className="item">
              <div className="item-main">
                <strong>
                  {u.username} {u.isAdmin && <Badge tone="accent">管理者</Badge>}{' '}
                  {u.username === auth?.user?.username && <Badge>あなた</Badge>}
                </strong>
                <span className="hint">登録: {fmt(u.createdAt)}</span>
              </div>
              {u.username !== auth?.user?.username && (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !confirm(
                          `${u.username} さんをサインアウトさせ、新しいリカバリーコードを発行しますか?`,
                        )
                      )
                        return;
                      void act(async () => {
                        const r = await api.resetUser(u.id);
                        setResetCodes({ username: u.username, codes: r.codes });
                      });
                    }}
                  >
                    復旧コードを再発行
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger-text"
                    disabled={busy}
                    onClick={() => {
                      if (
                        prompt(
                          `${u.username} さんのアカウントと、このサービス内のノートをすべて削除します。確認のためユーザー名を入力してください。`,
                        ) !== u.username
                      )
                        return;
                      void act(async () => {
                        await api.deleteUser(u.id);
                        users.reload();
                        toast.show('削除しました', { kind: 'success' });
                      });
                    }}
                  >
                    削除
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {signup === 'invite' && (
        <section className="card">
          <h2>招待</h2>
          <p className="hint">招待リンクは1回だけ使えます(7日間有効)。</p>
          {newInvite && (
            <div className="notice notice-ok">
              <p>招待リンクを作成しました。このリンクは今しか表示されません。</p>
              <pre className="secret-box">{newInvite.url}</pre>
              <CopyButton text={newInvite.url} label="リンクをコピー" />
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.createInvite(7);
                setNewInvite({ url: r.url, code: r.code });
                invites.reload();
              })
            }
          >
            {busy && <Spinner />}
            招待リンクを作成
          </button>
          {invites.data && invites.data.length > 0 && (
            <ul className="item-list">
              {invites.data.map((i) => (
                <li key={i.id} className="item">
                  <div className="item-main">
                    <span className="mono">{i.id}…</span>
                    <span className="hint">
                      作成 {fmt(i.createdAt)} ・{' '}
                      {i.usedAt
                        ? `使用済み (${fmt(i.usedAt)})`
                        : i.expiresAt && i.expiresAt < new Date().toISOString()
                          ? '期限切れ'
                          : `期限 ${fmt(i.expiresAt)}`}
                    </span>
                  </div>
                  {!i.usedAt && (
                    <button
                      type="button"
                      className="btn btn-small btn-danger-text"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.deleteInvite(i.id);
                          invites.reload();
                        })
                      }
                    >
                      取り消す
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
