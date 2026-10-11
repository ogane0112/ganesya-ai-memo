# GitHub リポジトリの設定手順

[ソースコードのセキュリティ方針](secure-development.md) を GitHub 側で効かせるための設定です。設定はリポジトリの管理者が画面から行います(コードやCIからは変えられません)。所要時間は15分ほどです。

> GitHub の画面の名前や配置は変わることがあります。見つからないときは、Settings の左のメニューで似た名前を探すか、設定画面の上の検索を使ってください。

## チェックリスト

| #   | 設定                           | 場所                                          | 目的                                           |
| --- | ------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| 1   | アカウントの2段階認証          | 個人の Settings → Password and authentication | リポジトリを乗っ取られないため                 |
| 2   | デフォルトブランチを `main` に | Settings → General                            | CI・Dependabot・定期実行が `main` を基準に動く |
| 3   | Actions の権限を最小に         | Settings → Actions → General                  | CI が勝手にリポジトリを書き換えられないように  |
| 4   | Code security の各機能         | Settings → Code security                      | 脆弱性・漏れたシークレットを見つける           |
| 5   | `main` の保護(ルールセット)    | Settings → Rules → Rulesets                   | CI が通らない変更や、履歴の書き換えを止める    |
| 6   | 古いブランチの削除             | Code → Branches                               | `claude/ai-note-app` を残さない                |

## 1. アカウントの2段階認証

右上のアイコン → **Settings** → **Password and authentication**。

- **Two-factor authentication** を有効にする。パスキーかセキュリティキーを登録するのがおすすめ(SMS は避ける)
- 表示されるリカバリーコードを保存する
- **Sessions** に心当たりのない端末がないか確認する

## 2. デフォルトブランチを `main` にする

リポジトリの **Settings** → **General** → **Default branch**。

1. 両矢印のボタンを押し、`main` を選んで **Update**
2. 確認画面で **I understand, update the default branch** を押す

同じ画面の **Pull Requests** で、次も設定しておくと便利です。

- **Allow squash merging** だけを有効にする(履歴が1PR=1コミットになる)。好みで構いません
- **Automatically delete head branches** を有効にする(マージ後に作業ブランチを自動で消す)

## 3. Actions の権限を最小にする

**Settings** → **Actions** → **General**。

- **Actions permissions**:**Allow ogane0112, and select non-ogane0112, actions and reusable workflows** を選び、**Allow actions created by GitHub** と **Allow actions by Marketplace verified creators** にチェック(このリポジトリが使うのは `actions/*`、`github/codeql-action`、`docker/*` のみ)
- **Require actions to be pinned to a full-length commit SHA** があれば有効にする(このリポジトリのワークフローは全部SHAで固定済み)
- **Fork pull request workflows from outside collaborators**:**Require approval for all external contributors**
- **Workflow permissions**:**Read repository contents and packages permissions** を選ぶ
- **Allow GitHub Actions to create and approve pull requests** はオフ

## 4. Code security

**Settings** → **Code security**(**Security** → **Code security and analysis** の場合もあります)。公開リポジトリはすべて無料です。

| 項目                                | 設定       | 説明                                                                |
| ----------------------------------- | ---------- | ------------------------------------------------------------------- |
| **Private vulnerability reporting** | Enable     | 外部の人が非公開で脆弱性を報告できる([SECURITY.md](../SECURITY.md)) |
| **Dependency graph**                | Enable     | 依存関係の一覧(Dependabot の前提)                                   |
| **Dependabot alerts**               | Enable     | 依存ライブラリの脆弱性を通知                                        |
| **Dependabot security updates**     | Enable     | 脆弱性の修正PRを自動で作成                                          |
| **Grouped security updates**        | Enable     | 修正PRをまとめる                                                    |
| **Dependabot version updates**      | (設定済み) | `.github/dependabot.yml` で週次の更新PRが作られる                   |
| **Code scanning**(CodeQL)           | 下記       | `.github/workflows/codeql.yml` で設定済み                           |
| **Secret scanning**                 | Enable     | コミットされたAPIキーなどを検出                                     |
| **Push protection**                 | Enable     | シークレットを含む push をその場で止める                            |

Code scanning は **Default setup** を有効に**しないで**ください。このリポジトリは独自のワークフロー(Advanced setup、`security-extended` のクエリを使用)で動かしているので、Default setup を有効にすると二重になるか、ワークフローが止められます。

通知を受け取るために、リポジトリ上部の **Watch** → **Custom** → **Security alerts** にチェックを入れておきます。

## 5. `main` を保護する(ルールセット)

**Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**。

| 項目               | 設定                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| Ruleset Name       | `main`                                                                   |
| Enforcement status | **Active**                                                               |
| Bypass list        | 空のまま(管理者も例外にしない。緊急時はルールセットを一時的に無効にする) |
| Target branches    | **Add target** → **Include default branch**                              |

**Branch rules** で次にチェックを入れます。

- **Restrict deletions**(`main` を消せないように)
- **Block force pushes**(履歴を書き換えられないように)
- **Require linear history**(squash マージだけにする場合)
- **Require a pull request before merging**
  - **Required approvals**:**0**(1人で開発している間は。自分のPRは自分で承認できないため、1以上にするとマージできなくなります。共同開発者が増えたら1以上に)
  - **Dismiss stale pull request approvals when new commits are pushed**:オン
  - **Require conversation resolution before merging**:オン(レビューの指摘を放置したままマージしない)
- **Require status checks to pass**
  - **Require branches to be up to date before merging**:オン
  - **Add checks** で次の4つを追加(一度CIが動いたあとでないと候補に出ません。PR #1 で動いています)
    - `check`(lint・型・テスト・ビルド)
    - `security`(パッケージ署名・台帳チェック・SBOM)
    - `docker`
    - `analyze`(CodeQL)
- **Require code scanning results**
  - **Add tool** → `CodeQL`、**Security alerts**:**High or higher**、**Alerts**:**Errors**

**Create** で保存します。

> 旧来の **Settings** → **Branches** → **Add branch protection rule** でも同じことができます。どちらか一方だけにしてください。

## 6. 古いブランチを消す

`main` がデフォルトになり、PR #1 がマージされたら、**Code** → **Branches** で次を削除します。

- `claude/ai-note-app`(`main` と同じ内容で作られた元のブランチ)
- `claude/workers-multitenant`(PR #1 のブランチ。手順2で自動削除をオンにしていれば不要)

## 設定できたかの確認

- [ ] リポジトリのトップで、ブランチ名が `main` と表示される
- [ ] **Security** タブに **Code scanning**、**Dependabot**、**Secret scanning** が並び、エラーがない
- [ ] **Security** → **Advisories** に **Report a vulnerability** ボタンがある(ログアウトした状態や別アカウントで確認)
- [ ] PR の画面で、必須のチェック(Required)として `check`、`security`、`docker`、`analyze` が表示される
- [ ] `main` に直接 push しようとすると拒否される(`git push origin HEAD:main` を試すと `protected branch` のエラー)
- [ ] 月曜日に Dependabot のPRが届く(依存が最新なら届かないこともある)

## 運用で見る場所

| 頻度   | 見る場所                                    | すること                                                                      |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 随時   | 通知(Security alerts、Dependabot のPR)      | 台帳に登録して期限内に対応([方針](secure-development.md#2-脆弱性cveへの対応)) |
| 毎週   | Pull requests(Dependabot)                   | CI が通っていれば内容を見てマージ。本番の依存はステージングで確認してから     |
| 毎月   | Security タブ全体、Settings → Collaborators | 未対応のアラートがないか、不要な権限がないか                                  |
| 四半期 | Settings 全体                               | この手順の設定が変わっていないか                                              |
