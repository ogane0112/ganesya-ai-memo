import type { AppEnv } from '../api/types';

const LABEL: Record<Exclude<AppEnv, 'production'>, { title: string; text: string }> = {
  staging: {
    title: 'STG',
    text: '検証環境です。本番とは別のデータで、あなただけがアクセスできます。',
  },
  development: { title: 'DEV', text: '開発環境です。データは本番と関係ありません。' },
};

/** A stripe at the top of every screen outside production, so environments are never confused. */
export function EnvBanner({ env }: { env: AppEnv | undefined }) {
  if (!env || env === 'production') return null;
  const l = LABEL[env];
  return (
    <div className={`env-banner env-${env}`} role="note">
      <strong>{l.title}</strong>
      <span>{l.text}</span>
    </div>
  );
}
