import type { BlockAttribution } from '@gmemo/core';
import type { NoteSummary, ProposalRow, PublicFinding } from '../api/types';

/** Sample data shared by stories. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const sampleNotes: NoteSummary[] = [
  {
    path: 'Projects/新サービス企画.md',
    title: '新サービス企画',
    createdBy: 'human',
    aiAgent: null,
    updatedAt: minutesAgo(3),
    tags: ['企画', '2026Q4'],
  },
  {
    path: 'Projects/週次ミーティング.md',
    title: '週次ミーティング',
    createdBy: 'ai',
    aiAgent: 'Claude',
    updatedAt: minutesAgo(90),
    tags: ['会議'],
  },
  {
    path: '読書/リーダブルコード.md',
    title: 'リーダブルコード',
    createdBy: 'human',
    aiAgent: null,
    updatedAt: minutesAgo(60 * 26),
    tags: ['本'],
  },
  {
    path: 'Inbox/2026-10-10.md',
    title: '2026-10-10',
    createdBy: 'human',
    aiAgent: null,
    updatedAt: minutesAgo(60 * 24 * 5),
    tags: [],
  },
];

export const samplePaths = sampleNotes.map((n) => n.path);

export function sampleProposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 'pr_demo',
    agent_id: 'ag_demo',
    author_name: 'Claude',
    author_kind: 'ai',
    source: 'agent',
    branch: 'proposals/pr_demo',
    base_commit: '0'.repeat(40),
    title: '課題に解決案を追記',
    description: '競合時の扱いについて、段落単位のマージ案を追加しました。',
    status: 'open',
    created_at: minutesAgo(2),
    updated_at: minutesAgo(2),
    merged_commit: null,
    ...over,
  } as ProposalRow;
}

export const sampleMarkdown = `# 新サービス企画

社内向けのメモアプリを、AIと一緒に育てる。[[週次ミーティング]] で方向性を確認する。

## 目標

- 書いたその場でAIが整理を手伝う
- AIの変更は必ず人が承認する

> 迷ったら、書く人がいちばん楽な方を選ぶ。

\`\`\`ts
const merged = mergeNotes(base, ours, theirs);
\`\`\`

| 項目 | 担当 |
| --- | --- |
| 設計 | hanako |
| 実装 | Claude |
`;

export const sampleBlameBody = `新サービスの方向性を整理する。

解決案: 段落単位で三方向マージし、同じ段落を両方が変えたときだけ人に確認する。

次回までに画面のたたき台を作る。
`;

export const sampleBlame: BlockAttribution[] = [
  {
    index: 0,
    text: '新サービスの方向性を整理する。\n\n',
    author: { kind: 'human', name: 'hanako' },
    commit: 'a'.repeat(40),
    date: minutesAgo(120),
  },
  {
    index: 1,
    text: '解決案: 段落単位で三方向マージし、同じ段落を両方が変えたときだけ人に確認する。\n\n',
    author: { kind: 'ai', name: 'Claude' },
    commit: 'b'.repeat(40),
    date: minutesAgo(30),
  },
  {
    index: 2,
    text: '次回までに画面のたたき台を作る。\n',
    author: { kind: 'human', name: 'hanako' },
    commit: 'c'.repeat(40),
    date: minutesAgo(10),
  },
];

export const sampleFindings: PublicFinding[] = [
  {
    rule: 'aws-access-key',
    category: 'credential',
    label: 'AWSアクセスキー',
    start: 0,
    end: 20,
    fingerprint: 'f1',
    preview: 'AK••••••••LE',
  },
  {
    rule: 'phone-jp',
    category: 'personal',
    label: '電話番号',
    start: 30,
    end: 43,
    fingerprint: 'f2',
    preview: '09••••••••78',
  },
];
