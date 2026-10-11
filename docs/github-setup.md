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

### そもそも GitHub Actions とは

PR を出したときに動いている CI(lint、テスト、CodeQL など)は、**GitHub Actions** という仕組みで動いています。`.github/workflows/*.yml` に書いた手順を、GitHub が用意した使い捨てのサーバーで実行します。

手順の中では、ほかの人が作った部品(**アクション**)を呼び出しています。たとえば `actions/checkout` はコードを取ってくる部品、`docker/build-push-action` は Docker イメージを作る部品です。

CI には次のものが渡ります。そのため、CI が乗っ取られるとリポジトリそのものが危険にさらされます。

- **リポジトリのコード**
- **`GITHUB_TOKEN`**:リポジトリを操作するための一時的な鍵(権限によっては push や設定変更もできる)
- **シークレット**:登録していれば、デプロイ用の Cloudflare の API トークンなど

実際に、有名なアクションが乗っ取られて、それを使っていた多数のリポジトリからシークレットが盗まれた事件が起きています(2025年の `tj-actions/changed-files` など)。以下の設定は、こうした経路を1つずつ塞ぐものです。

### 設定する場所

**Settings** → **Actions** → **General**。上から順に、次の5つを設定します。

#### ① Actions permissions(どのアクションを使ってよいか)

**Allow ogane0112, and select non-ogane0112, actions and reusable workflows** を選び、その下の次の2つにチェックを入れます(画面ではあなたのユーザー名が表示されます)。

- **Allow actions created by GitHub**
- **Allow actions by Marketplace verified creators**

**意味**:使ってよいアクションを、自分のもの・GitHub 公式・GitHub が身元を確認した作者のものに限定します。初期設定の「すべて許可」のままだと、誰が作ったか分からないアクションも動かせます。

**防げること**:作業中にうっかり(または AI が提案したまま)怪しいアクションをワークフローに追加しても、実行されずに止まります。

**このリポジトリへの影響**:使っているのは `actions/*`(GitHub 公式)、`github/codeql-action`(GitHub 公式)、`docker/*`(Docker 社、確認済みの作者)だけなので、今の CI はそのまま動きます。

#### ② Require actions to be pinned to a full-length commit SHA(バージョンを固定する)

この項目が画面にあれば、チェックを入れます(まだ表示されないアカウントもあります)。

**意味**:アクションを `actions/checkout@v4` のような**タグ**ではなく、`actions/checkout@11d5960a…` のような**コミットSHA(中身のハッシュ値)**で指定することを必須にします。

**防げること**:タグは作者(や乗っ取った攻撃者)があとから別の中身に付け替えられます。前述の事件はまさにこの手口でした。SHA は中身そのものを指すので、すり替えられません。

**このリポジトリへの影響**:ワークフローはすべて SHA で固定済みです。更新は Dependabot が SHA ごと書き換えた PR を作るので、手作業は増えません。

#### ③ Fork pull request workflows from outside collaborators(外部からの PR)

**Require approval for all external contributors** を選びます。

**意味**:このリポジトリは公開なので、誰でもフォーク(コピー)して PR を出せます。その PR で CI を動かす前に、あなたの承認を必要にします。

**防げること**:悪意のある人が、ワークフローや中身を書き換えた PR を出して、こちらの CI の上で任意のコードを動かす(計算資源の悪用、キャッシュの汚染など)ことを防ぎます。フォークからの PR にはシークレットが渡らない仕組みもありますが、承認制にすることで「中身を見てから動かす」ことができます。

**運用**:外部の人から PR が来ると「Approve and run」というボタンが出ます。変更内容(特に `.github/` と `package.json`)を見て、問題なければ押します。

#### ④ Workflow permissions(CI に渡す鍵の強さ)

**Read repository contents and packages permissions** を選びます。

**意味**:CI に自動で渡される `GITHUB_TOKEN` を、初期状態で**読み取り専用**にします。

**防げること**:テストで使っている依存ライブラリなどが乗っ取られて CI の中で悪いコードが動いても、その鍵ではリポジトリへの push、リリースの作成、Issue や設定の書き換えができません。

**このリポジトリへの影響**:ワークフローにも `permissions: contents: read` を書いてあり、二重に絞っています。CodeQL のジョブだけは結果を送るために `security-events: write` をワークフロー側で明示的に追加しているので、この設定のままで動きます。

#### ⑤ Allow GitHub Actions to create and approve pull requests(CI が PR を承認できるか)

**チェックを外したまま**にします。

**意味**:CI が PR を作ったり、**承認したり**できるようにする設定です。

**防げること**:これを許すと、CI が乗っ取られたときに「PR を作る → 自分で承認する → マージする」という形で、レビューを素通りして `main` に変更を入れられてしまいます。オフにしておけば、承認は必ず人が行います。

**このリポジトリへの影響**:Dependabot の更新 PR は Dependabot 自身が作るので、この設定とは関係なく届きます。

### この節の設定で変わらないこと

- CI の動き方や結果は今までどおりです(PR を出せば check、security、docker、CodeQL が動く)。
- あとで Cloudflare への自動デプロイを CI に追加する場合は、デプロイ用のシークレットを **Settings** → **Environments** で `production` 環境に登録し、その環境に「承認が必要」を付けて、人が承認したときだけ使えるようにします(必要になったら手順を追加します)。

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
