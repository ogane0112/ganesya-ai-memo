import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';

const ITEMS = [
  { to: '/views', icon: 'table', label: 'ビュー', desc: '表・カンバン・カレンダー' },
  { to: '/graph', icon: 'graph', label: 'グラフ', desc: 'ノートのつながり' },
  { to: '/history', icon: 'history', label: '履歴', desc: '変更の記録と取り消し' },
  { to: '/search?tab=ask', icon: 'ask', label: 'ノートに質問', desc: 'AIがノートから答えます' },
  {
    to: '/settings',
    icon: 'settings',
    label: '設定',
    desc: '見た目・パスキー・AIエージェント・AIポリシー・バックアップ',
  },
  {
    to: '/privacy',
    icon: 'shield',
    label: 'データの扱い',
    desc: '誰が読めるか、AIに何を渡すか、何を記録しているか',
  },
];

export function MorePage() {
  useDocumentTitle('その他');
  return (
    <div className="page">
      <PageHeader title="その他" />
      <ul className="menu-cards">
        {ITEMS.map((i) => (
          <li key={i.to}>
            <Link to={i.to} className="menu-card">
              <Icon name={i.icon} size={24} />
              <span>
                <strong>{i.label}</strong>
                <span className="hint">{i.desc}</span>
              </span>
              <Icon name="chevron" size={18} className="push" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
