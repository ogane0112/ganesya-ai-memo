import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, describeError } from '../api/client';
import type { AgentPermissions, Scope } from '../api/types';
import { AgentForm, defaultAgent, SCOPE_LABEL } from '../components/AgentForm';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, Spinner } from '../components/ui';
import { useAsync, useDocumentTitle } from '../lib/hooks';

/** Consent screen for MCP clients connecting with OAuth (the server redirects /oauth/authorize here). */
export function OAuthConsentPage() {
  useDocumentTitle('AIの接続を許可');
  const loc = useLocation();
  const query = loc.search;
  const queryObj = useMemo(() => Object.fromEntries(new URLSearchParams(query)), [query]);
  const req = useAsync(() => api.oauthRequest(query), [query]);
  const [choice, setChoice] = useState<string>('new');
  const [perms, setPerms] = useState<AgentPermissions>(defaultAgent());
  const [scopes, setScopes] = useState<Set<Scope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!req.data) return;
    const linked = req.data.client.linkedAgentId;
    setChoice(linked && req.data.agents.some((a) => a.id === linked) ? linked : 'new');
    setPerms(defaultAgent(req.data.client.name));
    setScopes(new Set(req.data.request.scope));
  }, [req.data]);

  if (req.loading) return <Loading />;
  if (req.error) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <ErrorBox error={req.error} title="この接続リクエストは無効です" />
          <p className="hint">AI 側でもう一度接続をやり直してください。</p>
        </div>
      </div>
    );
  }
  const { request, client, agents } = req.data!;
  let redirectHost = client.redirectUri;
  try {
    redirectHost = new URL(client.redirectUri).host || client.redirectUri;
  } catch {
    /* keep raw */
  }

  const submit = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.oauthConsent({
        query: queryObj,
        approve,
        ...(approve && choice !== 'new' ? { agentId: choice } : {}),
        ...(approve && choice === 'new'
          ? { newAgent: { ...perms, name: perms.name.trim() || client.name } }
          : {}),
        ...(approve ? { scope: [...scopes] } : {}),
      });
      location.href = r.redirect;
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <h1>
          <Icon name="bot" size={24} /> 「{client.name}」がノートへのアクセスを求めています
        </h1>
        <p className="hint">
          許可すると <strong className="mono">{redirectHost}</strong>{' '}
          に戻ります。心当たりがない場合は拒否してください。
        </p>

        <fieldset className="fieldset">
          <legend>許可する操作</legend>
          {request.scope.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={(e) =>
                  setScopes((prev) => {
                    const n = new Set(prev);
                    if (e.target.checked) n.add(s);
                    else n.delete(s);
                    return n;
                  })
                }
              />
              {SCOPE_LABEL[s] ?? s} <code className="hint">{s}</code>
            </label>
          ))}
        </fieldset>

        <fieldset className="fieldset">
          <legend>どのエージェントとして接続しますか</legend>
          {agents.map((a) => (
            <label key={a.id} className="radio">
              <input
                type="radio"
                name="agent"
                checked={choice === a.id}
                onChange={() => setChoice(a.id)}
              />
              <span>
                <strong>{a.name}</strong>{' '}
                <span className="hint">
                  {a.writeMode === 'direct'
                    ? '直接書き込み'
                    : a.writeMode === 'propose'
                      ? '提案'
                      : '読むだけ'}{' '}
                  ・{a.location === 'external' ? '外部' : 'ローカル'}
                  {a.id === client.linkedAgentId && ' ・前回の接続先'}
                </span>
              </span>
            </label>
          ))}
          <label className="radio">
            <input
              type="radio"
              name="agent"
              checked={choice === 'new'}
              onChange={() => setChoice('new')}
            />
            <span>
              <strong>新しいエージェントを作る</strong>
            </span>
          </label>
        </fieldset>
        {choice === 'new' && <AgentForm value={perms} onChange={setPerms} />}

        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <div className="row between">
          <button type="button" className="btn" onClick={() => void submit(false)} disabled={busy}>
            拒否
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit(true)}
            disabled={busy || scopes.size === 0}
          >
            {busy && <Spinner />}
            許可する
          </button>
        </div>
      </div>
    </div>
  );
}
