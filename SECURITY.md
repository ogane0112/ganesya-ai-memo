# セキュリティポリシー

## 脆弱性の報告

公開の Issue ではなく、GitHub の [Security Advisories(非公開の報告)](https://github.com/ogane0112/ganesya-ai-memo/security/advisories/new) からお知らせください。

- 再現手順、影響(誰が何をできるか)、対象のバージョンかコミットを書いてください
- 受け取ったら、数日以内に返信します
- 修正までの期限は、深刻度に応じて [ソースコードのセキュリティ方針](docs/secure-development.md#対応期限) に従います
- 修正を公開するまでは、内容を公開しないでください

## 対象

このリポジトリのコード(サーバー、Webアプリ、デプロイ設定)。利用者自身が運用しているサーバーの設定不備は対象外です。

## 対応状況

見つかった脆弱性と対応は [`security/vulnerabilities.yaml`](security/vulnerabilities.yaml) で管理しています。
