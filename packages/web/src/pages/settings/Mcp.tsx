import { Link } from 'react-router-dom';
import { CopyButton } from '../../components/ui';
import { useApp } from '../../state/app';

export function McpSettings() {
  const { auth } = useApp();
  const origin = auth?.origin ?? location.origin;
  const mcpUrl = `${origin}/mcp`;
  const claudeCode = `claude mcp add --transport http gmemo ${mcpUrl}`;
  const desktopJson = JSON.stringify(
    { mcpServers: { gmemo: { type: 'http', url: mcpUrl } } },
    null,
    2,
  );
  return (
    <div className="stack">
      <section className="card">
        <h2>MCP で AI をつなぐ</h2>
        <p>
          Claude などの MCP 対応 AI から、あなたのノートを読んだり、変更を提案させたりできます。
        </p>
        <div className="field">
          <span className="label">MCP サーバーの URL</span>
          <div className="row">
            <code className="code-inline grow">{mcpUrl}</code>
            <CopyButton text={mcpUrl} />
          </div>
        </div>
        <p className="hint">
          認証は OAuth で自動的に行われます。AI
          側で接続すると、このアプリの許可画面が開くので、パスキーでサインインしてエージェントの権限を選んでください。
        </p>
      </section>
      <section className="card">
        <h3>Claude Code</h3>
        <div className="row">
          <code className="code-inline grow">{claudeCode}</code>
          <CopyButton text={claudeCode} />
        </div>
        <h3>設定ファイル(JSON)を使うクライアント</h3>
        <pre className="code-block">{desktopJson}</pre>
        <CopyButton text={desktopJson} />
        <h3>OAuth に対応していないクライアント</h3>
        <p className="hint">
          <Link to="/settings/agents">AIエージェント</Link> でトークンを発行し、
          <code>Authorization: Bearer &lt;トークン&gt;</code> ヘッダーを付けて接続してください。
        </p>
      </section>
      <section className="card">
        <h3>安全のしくみ</h3>
        <ul className="bullets">
          <li>
            AI の書き込みは基本的に「提案」になり、レビュー画面で承認するまでノートは変わりません。
          </li>
          <li>エージェントごとに、読めるフォルダ・書き込み方法・自動取り込みを設定できます。</li>
          <li>
            外部(クラウド)の AI には、AIポリシーで外部送信が許可されたノートだけが渡されます。
          </li>
          <li>すべての変更は履歴に残り、「このAIの変更をすべて取り消す」で一括で戻せます。</li>
        </ul>
      </section>
    </div>
  );
}
