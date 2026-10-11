import { NavLink, Navigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { useApp } from '../../state/app';
import { AdminSettings } from './Admin';
import { AgentsSettings } from './Agents';
import { AppearanceSettings } from './Appearance';
import { AiPolicySettings, AuditLog } from './AiPolicy';
import { CalendarSettings } from './Calendar';
import { DataSettings } from './Data';
import { McpSettings } from './Mcp';
import { SecuritySettings } from './Security';
import { SecurityLogSettings } from './SecurityLog';
import { StorageSettings } from './Storage';

const SECTIONS = [
  { id: 'appearance', label: '見た目', el: <AppearanceSettings /> },
  { id: 'security', label: 'パスキー', el: <SecuritySettings /> },
  { id: 'security-log', label: 'セキュリティログ', el: <SecurityLogSettings /> },
  { id: 'agents', label: 'AIエージェント', el: <AgentsSettings /> },
  { id: 'mcp', label: 'MCP接続', el: <McpSettings /> },
  { id: 'ai', label: 'AIポリシー', el: <AiPolicySettings /> },
  { id: 'audit', label: 'AI送信ログ', el: <AuditLog /> },
  { id: 'calendar', label: 'カレンダー連携', el: <CalendarSettings /> },
  { id: 'storage', label: '保存先', el: <StorageSettings /> },
  { id: 'data', label: 'データ・アカウント', el: <DataSettings /> },
  { id: 'admin', label: 'サーバー管理', el: <AdminSettings />, admin: true },
];

export function SettingsPage() {
  const { section } = useParams();
  const { auth } = useApp();
  const sections = SECTIONS.filter((s) => !s.admin || auth?.user?.isAdmin);
  const current = sections.find((s) => s.id === section);
  useDocumentTitle(current ? `設定: ${current.label}` : '設定');
  if (!current) return <Navigate to="/settings/appearance" replace />;
  return (
    <div className="page">
      <PageHeader title="設定" />
      <nav className="tabs" aria-label="設定の項目">
        {sections.map((s) => (
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
