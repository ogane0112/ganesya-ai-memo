import type { WorkspacePolicy } from '@gmemo/core';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAsync } from '../lib/hooks';

/** No folder is shared with external AI (single notes may still be, through their properties). */
export function sharesNothingExternally(policy: WorkspacePolicy): boolean {
  return (
    policy.ai.default !== 'external' &&
    !Object.values(policy.ai.folders).some((a) => a === 'external')
  );
}

/**
 * Shown where an external AI (Claude and others over MCP) is connected or
 * set up while the AI policy shares nothing with external AI: without it the
 * agent connects fine and then finds an empty notebook, with no hint why.
 */
export function ExternalShareWarning({ show }: { show: boolean }) {
  const policy = useAsync(() => api.policy(), []);
  if (!show || !policy.data || !sharesNothingExternally(policy.data)) return null;
  return (
    <div className="notice notice-warn" role="status">
      <strong>今の AI ポリシーでは、外部 AI に見せるフォルダーがありません。</strong>
      このままだと、外部 AI(Claude など)は接続できてもノートを 1 つも読めません。
      <Link to="/settings/ai">AI ポリシー</Link>
      で、見せてよいフォルダーを「外部AI可」にしてください(ノート単位なら、編集画面のプロパティの「AIへの送信」でも設定できます)。
    </div>
  );
}
