import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { SecurityEvent, SecurityLogCheck } from '../../api/types';
import { Badge, EmptyState, ErrorBox, Loading, Segmented, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useApp } from '../../state/app';

/** Human-readable names for security events. */
export const ACTION_LABEL: Record<string, string> = {
  'auth.signup': 'アカウント作成',
  'auth.login': 'サインイン',
  'auth.recovery_login': 'リカバリーコードでサインイン',
  'auth.logout': 'サインアウト',
  'auth.logout_all': 'すべての端末からサインアウト',
  'auth.passkey_add': 'パスキーを追加',
  'auth.passkey_delete': 'パスキーを削除',
  'auth.recovery_codes_regenerated': 'リカバリーコードを再発行',
  'account.delete': 'アカウントを削除',
  'agent.create': 'AIエージェントを作成',
  'agent.update': 'AIエージェントの設定を変更',
  'agent.revoke': 'AIエージェントを無効化',
  'agent.read': 'AIがノートを読み取り',
  'agent.search': 'AIが検索',
  'agent.write': 'AIが書き込み・提案',
  'agent.revert_all': 'AIの変更をまとめて取り消し',
  'token.create': 'アクセストークンを発行',
  'token.revoke': 'アクセストークンを失効',
  'token.rejected': '無効なトークンでのアクセス',
  'oauth.client_register': 'MCPクライアントの登録',
  'oauth.consent': 'MCPクライアントの接続許可',
  'oauth.token_issue': 'MCPクライアントへのトークン発行',
  'oauth.token_refresh': 'MCPクライアントのトークン更新',
  'oauth.client_disconnect': 'MCPクライアントの接続を解除',
  'policy.update': 'AIポリシーを変更',
  'policy.allow_finding': '機密情報の検出を「問題なし」に',
  'storage.change': '保存先を変更',
  'storage.github_forget': 'GitHub接続を削除',
  'data.export': 'ノートをエクスポート',
  'calendar.feed_create': 'カレンダーの公開URLを作成',
  'calendar.feed_revoke': 'カレンダーの公開URLを無効化',
  'proposal.merge': '提案を取り込み',
  'proposal.reject': '提案を却下',
  'admin.user_delete': '管理者がアカウントを削除',
  'admin.user_reset': '管理者がリカバリーコードを再発行',
  'admin.invite_create': '招待リンクを作成',
  'admin.invite_delete': '招待リンクを取り消し',
  'security.rate_limited': '試行回数の上限に到達',
  'security.cross_origin_rejected': '別サイトからの操作を拒否',
  'audit.verify': '監査ログの改ざんチェック',
  'audit.retention_purge': '保存期間を過ぎたログを削除',
};

const OUTCOME = {
  success: { label: '成功', tone: 'ok' },
  failure: { label: '失敗', tone: 'danger' },
  denied: { label: '拒否', tone: 'warn' },
} as const;

function actorLabel(actor: string): string {
  if (actor.startsWith('agent:')) return 'AIエージェント';
  if (actor.startsWith('user:')) return 'ユーザー';
  if (actor === 'system') return 'システム';
  return '未サインイン';
}

function detailText(e: SecurityEvent): string {
  const d = e.detail;
  const parts: string[] = [];
  for (const key of [
    'agent',
    'username',
    'name',
    'client',
    'reason',
    'passkey',
    'status',
    'from',
    'to',
    'repo',
  ]) {
    const v = d[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  if (Array.isArray(d['paths'])) parts.push(`${(d['paths'] as unknown[]).length} 件のノート`);
  if (Array.isArray(d['results'])) parts.push(`結果 ${(d['results'] as unknown[]).length} 件`);
  if (typeof d['masked'] === 'number' && d['masked'] > 0) parts.push(`伏せ字 ${d['masked']} 件`);
  if (typeof d['access'] === 'string') parts.push(`Access: ${d['access']}`);
  return parts.join(' ・ ');
}

/** One security event (also shown in the design catalog). */
export function SecurityEventItem({
  e,
  showUser = false,
}: {
  e: SecurityEvent;
  showUser?: boolean;
}) {
  const o = OUTCOME[e.outcome];
  const detail = detailText(e);
  return (
    <li className={`item security-item security-${e.outcome}`}>
      <div className="item-main">
        <span className="row wrap">
          <Badge tone={o.tone}>{o.label}</Badge>
          <strong>{ACTION_LABEL[e.action] ?? e.action}</strong>
          <time className="hint" dateTime={e.at}>
            {formatDateTime(e.at)}
          </time>
        </span>
        <span className="hint">
          {actorLabel(e.actor)}
          {e.target && (
            <>
              {' ・ '}
              <span className="mono">{e.target}</span>
            </>
          )}
          {detail && ` ・ ${detail}`}
        </span>
        <span className="hint security-origin">
          {e.ua ?? '端末不明'}
          {e.ip && (
            <>
              {' ・ 接続元 '}
              <span className="mono">{e.ip.startsWith('h:') ? e.ip.slice(2, 10) : e.ip}</span>
            </>
          )}
          {showUser && e.userId && (
            <>
              {' ・ '}
              <span className="mono">{e.userId}</span>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

export function SecurityLogSettings() {
  const { auth } = useApp();
  const admin = !!auth?.user?.isAdmin;
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const [items, setItems] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<SecurityLogCheck | null>(null);

  const load = async (before?: number) => {
    setBusy(true);
    try {
      const q = {
        ...(scope === 'all' ? { scope: 'all' as const } : {}),
        ...(before ? { before } : {}),
      };
      // "Problems" = failures and denials, fetched as two filtered lists and merged.
      const page =
        filter === 'problems'
          ? [
              ...(await api.securityLog({ ...q, outcome: 'failure' })),
              ...(await api.securityLog({ ...q, outcome: 'denied' })),
            ].sort((a, b) => b.id - a.id)
          : await api.securityLog(q);
      setItems((prev) => (before && prev ? [...prev, ...page] : page));
      setMore(page.length >= 100);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setItems(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, filter]);

  const verify = async () => {
    setBusy(true);
    try {
      setCheck(await api.verifySecurityLog());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>セキュリティログ</h2>
        <p className="hint">
          サインイン、パスキーやトークンの変更、AIエージェントがどのノートを読み書きしたか、などの記録です。ノートの本文やトークンの値は記録しません。接続元のIPアドレスは、そのままではなく照合用の値に変換して残します。
        </p>
        <div className="row wrap">
          {admin && (
            <Segmented
              label="範囲"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'me', label: '自分のアカウント' },
                { value: 'all', label: 'サーバー全体' },
              ]}
            />
          )}
          <Segmented
            label="表示"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'すべて' },
              { value: 'problems', label: '失敗・拒否だけ' },
            ]}
          />
        </div>
        {admin && (
          <div className="row wrap">
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy && <Spinner />}
              改ざんチェック
            </button>
            {check && (
              <span
                className={
                  check.tampered.length || check.missing.length
                    ? 'notice notice-error'
                    : 'notice notice-ok'
                }
                role="status"
              >
                {check.tampered.length || check.missing.length
                  ? `問題があります: 書き換えられた記録 ${check.tampered.length} 件、抜けている記録 ${check.missing.reduce((n, m) => n + m.to - m.from + 1, 0)} 件`
                  : `${check.checked} 件の記録に問題はありません`}
                {check.unsigned > 0 &&
                  `(署名なし ${check.unsigned} 件: GMEMO_SECRET_KEY 未設定の期間)`}
              </span>
            )}
          </div>
        )}
      </section>

      {error ? (
        <ErrorBox error={error} onRetry={() => void load()} />
      ) : items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon="shield" title="記録はまだありません" />
      ) : (
        <section className="card">
          <ul className="item-list">
            {items.map((e) => (
              <SecurityEventItem key={e.id} e={e} showUser={scope === 'all'} />
            ))}
          </ul>
          {more && (
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => void load(items[items.length - 1]?.id)}
            >
              {busy && <Spinner />}
              さらに表示
            </button>
          )}
        </section>
      )}
    </div>
  );
}
