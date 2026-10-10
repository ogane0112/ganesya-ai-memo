import { NavLink, Navigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { AgentsSettings } from './Agents';
import { AppearanceSettings } from './Appearance';
import { AiPolicySettings, AuditLog } from './AiPolicy';
import { CalendarSettings } from './Calendar';
import { DataSettings } from './Data';
import { McpSettings } from './Mcp';
import { SecuritySettings } from './Security';

const SECTIONS = [
  { id: 'appearance', label: '見た目', el: <AppearanceSettings /> },
  { id: 'security', label: 'パスキー', el: <SecuritySettings /> },
  { id: 'agents', label: 'AIエージェント', el: <AgentsSettings /> },
  { id: 'mcp', label: 'MCP接続', el: <McpSettings /> },
  { id: 'ai', label: 'AIポリシー', el: <AiPolicySettings /> },
  { id: 'audit', label: 'AI送信ログ', el: <AuditLog /> },
  { id: 'calendar', label: 'カレンダー連携', el: <CalendarSettings /> },
  { id: 'data', label: 'データ', el: <DataSettings /> },
];

export function SettingsPage() {
  const { section } = useParams();
  const current = SECTIONS.find((s) => s.id === section);
  useDocumentTitle(current ? `設定: ${current.label}` : '設定');
  if (!current) return <Navigate to="/settings/appearance" replace />;
  return (
    <div className="page">
      <PageHeader title="設定" />
      <nav className="tabs" aria-label="設定の項目">
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} className="tab-link" replace>
            {s.label}
          </NavLink>
        ))}
        <NavLink to="/history" className="tab-link">
          履歴
        </NavLink>
      </nav>
      <div className="settings-body">{current.el}</div>
    </div>
  );
}
