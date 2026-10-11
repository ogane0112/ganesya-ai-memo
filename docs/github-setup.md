# GitHub リポジトリの設定手順

[ソースコードのセキュリティ方針](secure-development.md) を GitHub 側で効かせるための設定です。設定はリポジトリの管理者が画面から行います(コードやCIからは変えられません)。所要時間は15分ほどです。

> GitHub の画面の名前や配置は変わることがあります。見つからないときは、Settings の左のメニューで似た名前を探すか、設定画面の上の検索を使ってください。

## チェックリスト

| #   | 設定                           | 場所                                          | 目的                                           |
| --- | ------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| 1   | アカウントの2段階認証          | 個人の Settings → Password and authentication | リポジトリを乗っ取られないため                 |
| 2   | デフォルトブランチを `main` に | Settings → General                            | CI・Dependabot・定期実行が `main` を基準に動く |
| 3   | Actions の権限を最小に         | Settings → Actions → General                  | CI が勝手にリポジトリを書き換えられないように  |
| 4   | Advanced Security の各機能     | Settings → Advanced Security                  | 脆弱性・漏れたシークレットを見つける           |
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

## 4. Advanced Security(脆弱性とシークレットの検出)

**Settings** → 左メニューの **Advanced Security**。公開リポジトリはすべて無料です。

ページは上から「Private vulnerability reporting」「Dependency Scanning」「Code Security」「Secret Protection」の4つのブロックに分かれています。上から順に設定します。

### ① Private vulnerability reporting → **Enable**

**意味**:外部の人が、脆弱性を**公開の Issue ではなく非公開で**あなたに報告できる窓口を作ります。

**なぜ必要か**:脆弱性が公開の Issue に書かれると、直す前に攻撃者に知られてしまいます。[SECURITY.md](../SECURITY.md) にこの窓口を案内してあるので、有効にしないと案内先が存在しないことになります。

### ② Dependency Scanning(依存ライブラリ)

| 項目                            | 設定       | 意味                                                                                                       |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| **Dependency graph**            | **Enable** | `package-lock.json` から依存ライブラリの一覧を作る。下の Dependabot はこれが前提なので**最初に**有効にする |
| **Dependabot alerts**           | **Enable** | 使っているライブラリに脆弱性が公開されたら通知する                                                         |
| **Dependabot security updates** | **Enable** | 脆弱性に修正版があれば、更新のPRを自動で作る                                                               |
| **Grouped security updates**    | **Enable** | 上の修正PRを、1回にまとめる(PRが大量に来ないように)                                                        |
| **Dependabot version updates**  | (操作不要) | `.github/dependabot.yml` で設定済み。毎週月曜に、脆弱性と関係ない通常の更新PRも届く                        |

**security updates と version updates の違い**:security updates は「脆弱性があるから直す」更新で、見つかり次第すぐ届きます。version updates は「新しい版が出たから上げる」更新で、毎週まとめて届きます。どちらも PR として届き、CI が通ることを確認してからあなたがマージします(勝手に本番に入ることはありません)。

**届いたら**:security updates の PR は、[方針](secure-development.md#2-脆弱性cveへの対応)の期限内にマージし、`security/vulnerabilities.yaml` に記録します(記録を忘れると `security:check` が教えてくれます)。

### ③ Code Security(自分たちのコードの検査)

| 項目                                   | 設定                                | 意味                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CodeQL analysis**                    | **Advanced setup のまま**(操作不要) | `.github/workflows/codeql.yml` で動いている状態。右の「…」から **Default setup** に切り替え**ない**(切り替えると、このリポジトリ用の厳しめの設定 `security-extended` が使われなくなる) |
| **Other tools**                        | 操作不要                            | CodeQL 以外の検査ツールを追加する場所。今は不要                                                                                                                                        |
| **AI Scan for pull requests**(Preview) | **Off のまま**                      | CodeQL が対応していない言語を AI で検査する機能。このリポジトリは TypeScript で、CodeQL が対応しているので不要                                                                         |
| **Copilot Autofix**                    | **On のまま**                       | CodeQL が問題を見つけたときに、AI が修正案を PR に提案する。提案は自動では入らず、採用するかはあなたが決める。提案もほかのコードと同じくレビューしてから採用する                       |

**Protection rules → Check runs failure threshold**:CodeQL の結果で PR のチェックを「失敗」にする基準です。次のように設定します(初期値のままならそのままで構いません)。

- **Security alert severity level**:**High or higher**(重大度が高以上の脆弱性があれば失敗)
- **Standard alert severity level**:**Only errors**

ここで「失敗」にしても、それだけではマージを止められません。止めるには、手順5のルールセットで CodeQL のチェックを必須にします。

### ④ Secret Protection(パスワードや鍵の流出防止)

**Push protection** → **Enable**。

**意味**:API キー、トークン、秘密鍵などがコミットに含まれていると、**push の時点で止めます**。

**なぜ必要か**:公開リポジトリに一度 push したシークレットは、すぐに消しても、履歴やコピーから誰かに拾われる可能性があります。push の前に止めるのが一番確実です。止められた場合は、そのシークレットをコードから外してコミットし直します(本当にシークレットでない場合だけ、理由を選んで通過できます)。

**補足**:すでに公開されているシークレットの検出(Secret scanning)は、公開リポジトリでは GitHub が自動で行っています。Cloudflare の API トークンなどが見つかると、GitHub から Cloudflare に通知され、トークンが無効化されることがあります。

### 通知を受け取る

リポジトリ上部の **Watch** → **Custom** → **Security alerts** にチェックを入れます。これで、Dependabot や CodeQL の警告がメールや通知で届きます。

## 5. `main` を保護する(ルールセット)

### ルールセットとは

`main` に入る変更に「守らないといけない条件」を付ける機能です。設定すると、たとえば次のことができなくなります。

- CI が失敗している PR のマージ
- `main` への直接の push(PR を通さない変更)
- `main` の削除や履歴の書き換え(force push)

**自分自身(管理者)も例外にしない**のがポイントです。うっかりミスや、アカウントや CI が乗っ取られたときの被害を止められます。

> **始める前に**:手順2でデフォルトブランチを `main` にしておいてください。このルールセットは「デフォルトブランチ」を対象にするので、先に切り替えないと古いブランチが保護されます。

### 画面を開く

**Settings** → 左メニューの **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**。

画面は上から「名前」「Enforcement status」「Bypass list」「Target branches」「Rules」の順に並んでいます。上から順に設定します。

### ステップ1:名前と有効化

| 項目                   | 入力・選択    | 説明                                                                                       |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| **Ruleset Name**       | `main を保護` | 何でも構いません。一覧で見分けるための名前です                                             |
| **Enforcement status** | **Active**    | **Disabled** のままだと何も守られません。**Evaluate** は「違反を記録するだけ」で止めません |

### ステップ2:Bypass list(例外にする人)

**何も追加しない**(「Bypass list is empty」のまま)。

ここに追加した人やアプリは、ルールを無視できます。自分を入れたくなりますが、入れると「自分のアカウントが乗っ取られたら何でもできる」状態に戻ってしまいます。

緊急でどうしてもルールを外したいとき(GitHub の障害で CI が動かない等)は、この画面で **Enforcement status** を一時的に **Disabled** にし、作業後に **Active** に戻します。

### ステップ3:Target branches(どのブランチを守るか)

**Add target** → **Include default branch** を選び、「Include: Default」と表示されることを確認します。

デフォルトブランチ(`main`)だけが対象になります。作業用のブランチは自由に push できるままです。

### ステップ4:Rules(どのルールを付けるか)

チェックを入れるのは **5つ**、入れないものにも理由があります。

| ルール                                    | 設定                       | 理由                                                                                                                                                             |
| ----------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restrict creations                        | ☐ オフ                     | `main` はもうあるので不要                                                                                                                                        |
| Restrict updates                          | ☐ **オフ**                 | オンにすると例外の人しか `main` を更新できなくなり、**誰も PR をマージできなくなります**(例外は空にしたため)                                                     |
| **Restrict deletions**                    | ☑ **オン**                 | `main` を誤って(または乗っ取られて)消されないように                                                                                                              |
| **Require linear history**                | ☑ **オン**                 | 履歴を一直線にする。PR は「Squash and merge」(1つのPR = 1つのコミット)でマージすることになり、あとで「いつ何が入ったか」を追いやすい                             |
| Require deployments to succeed            | ☐ オフ                     | デプロイの成功をマージの条件にする機能。このリポジトリはマージ後に手動でデプロイするので不要                                                                     |
| Require signed commits                    | ☐ オフ                     | コミットへの電子署名を必須にする。署名の準備(鍵の登録)が必要になるので、今は不要。Squash でマージすると GitHub が署名したコミットになります                      |
| **Require a pull request before merging** | ☑ **オン**                 | `main` には PR を通した変更しか入らない。下の「詳細設定」も参照                                                                                                  |
| **Require status checks to pass**         | ☑ **オン**                 | CI が通った PR しかマージできない。下の「詳細設定」も参照                                                                                                        |
| **Block force pushes**                    | ☑ **オン**                 | `main` の履歴の書き換え・消去を禁止                                                                                                                              |
| Require code scanning results             | ☐ **今はオフ**(あとでオン) | CodeQL の重大な警告がある PR を止める。**`main` で一度 CodeQL が動くまでは、オンにすると PR #1 もマージできなくなる**ので、下の「ステップ6」で後からオンにします |
| Require code quality results              | ☐ オフ                     | GitHub の別機能(Code Quality)の結果を使う。今は使っていない                                                                                                      |
| Restrict code coverage                    | ☐ オフ                     | テストのカバー率を条件にする。カバー率を計測していないので不要                                                                                                   |
| Automatically request Copilot code review | ☐ お好みで                 | PR を出すと Copilot が自動でレビューする。AI クレジットを使います。レビューの目が増えるので、使えるならオンも可                                                  |

#### 「Require a pull request before merging」の詳細設定

チェックを入れると下に項目が開きます。

| 項目                                                             | 設定            | 理由                                                                                                                                 |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Required approvals**                                           | **0**           | 1人で開発している間は 0。**自分の PR は自分で承認できない**ので、1 以上にするとマージできなくなります。共同開発者が増えたら 1 以上に |
| Dismiss stale pull request approvals when new commits are pushed | ☑ オン          | 承認したあとに変更が追加されたら、承認を取り消す(承認後のすり替えを防ぐ)。承認数 0 の間は影響なし                                    |
| Require review from Code Owners                                  | ☐ オフ          | CODEOWNERS ファイルを使っていないので不要                                                                                            |
| Require approval of the most recent reviewable push              | ☐ オフ          | 共同開発者が増えたら検討                                                                                                             |
| **Require conversation resolution before merging**               | ☑ **オン**      | PR のレビューコメント(CodeQL の指摘を含む)がすべて「解決済み」になるまでマージできない。指摘の放置を防ぐ                             |
| **Allowed merge methods**                                        | **Squash** のみ | 「Require linear history」と合わせる。Merge commit を残すと、linear history のルールに引っかかってマージできません                   |

#### 「Require status checks to pass」の詳細設定

| 項目                                                 | 設定   | 理由                                                                                            |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| **Require branches to be up to date before merging** | ☑ オン | PR が古い `main` を元にしていたら、最新を取り込んでから CI を通し直す(マージ後に壊れるのを防ぐ) |
| Do not require status checks on creation             | ☐ オフ | ブランチ作成時の扱い。`main` は既にあるので影響なし                                             |

**Add checks** を押し、検索欄に次の名前を1つずつ入れて選びます(候補に **GitHub Actions** と表示されるものを選ぶ)。

| チェック名 | 中身                                                       |
| ---------- | ---------------------------------------------------------- |
| `check`    | lint、型チェック、テスト、ビルド                           |
| `security` | パッケージ署名の確認、台帳チェック(`security:check`)、SBOM |
| `docker`   | Docker イメージのビルド                                    |
| `analyze`  | CodeQL の解析(解析が最後まで動いたか)                      |

候補に出てこない場合は、そのチェックが一度も動いていません。PR #1 で動いているので、通常は表示されます。

### ステップ5:保存

一番下の **Create** を押します。一覧に「Active」と表示されれば完了です。

### ステップ6:PR #1 をマージしたあとで、CodeQL の結果も必須にする

PR #1 をマージすると、`main` で CodeQL が自動で動きます。**Security** → **Code scanning** に `main` の結果が出たら(数分後)、ルールセットを開いて次を追加します。

1. **Settings** → **Rules** → **Rulesets** → 作ったルールセットを開く
2. **Require code scanning results** にチェック
3. **Add tool** → **CodeQL** を選ぶ
4. **Security alerts**:**High or higher**(重大度が高以上の脆弱性が見つかったらマージできない)
5. **Alerts**:**Errors**
6. **Save changes**

`analyze`(ステップ4)は「CodeQL が動いたか」、このルールは「CodeQL が重大な問題を見つけていないか」を見ます。両方あってはじめて、脆弱性を含む PR を止められます。

### マージのしかた(設定後)

PR の画面の一番下で、緑のボタンが **Squash and merge** になっていることを確認して押します。

- CI が終わっていない、失敗している、未解決のコメントがある場合は、ボタンが押せず、理由が表示されます
- 「This branch is out-of-date」と出たら **Update branch** を押し、CI が通るのを待ってからマージします

## 6. 古いブランチを消す

`main` がデフォルトになり、PR #1 がマージされたら、**Code** → **Branches** で次を削除します。

- `claude/ai-note-app`(`main` と同じ内容で作られた元のブランチ)
- `claude/workers-multitenant`(PR #1 のブランチ。手順2で自動削除をオンにしていれば不要)

## 設定できたかの確認

- [ ] リポジトリのトップで、ブランチ名が `main` と表示される
- [ ] **Security** タブに **Code scanning**、**Dependabot**、**Secret scanning** が並び、エラーがない
- [ ] **Security** → **Advisories** に **Report a vulnerability** ボタンがある(ログアウトした状態や別アカウントで確認)
- [ ] PR の画面で、必須のチェック(Required)として `check`、`security`、`docker`、`analyze` が表示される
- [ ] GitHub の画面で `main` のファイル(README など)を編集して保存しようとすると、`main` に直接コミットできず、新しいブランチと PR の作成を求められる(確かめたら PR は作らずに閉じる)
- [ ] PR #1 のマージ後、ルールセットに **Require code scanning results**(CodeQL)を追加した(手順5のステップ6)
- [ ] 月曜日に Dependabot のPRが届く(依存が最新なら届かないこともある)

## 運用で見る場所

| 頻度   | 見る場所                                    | すること                                                                      |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 随時   | 通知(Security alerts、Dependabot のPR)      | 台帳に登録して期限内に対応([方針](secure-development.md#2-脆弱性cveへの対応)) |
| 毎週   | Pull requests(Dependabot)                   | CI が通っていれば内容を見てマージ。本番の依存はステージングで確認してから     |
| 毎月   | Security タブ全体、Settings → Collaborators | 未対応のアラートがないか、不要な権限がないか                                  |
| 四半期 | Settings 全体                               | この手順の設定が変わっていないか                                              |
