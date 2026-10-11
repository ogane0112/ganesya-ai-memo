import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useDocumentTitle } from '../lib/hooks';
import { useApp } from '../state/app';

/** 「データの扱い」: what this service stores, who can read it, and what the user controls. Public page. */
export function PrivacyPage() {
  useDocumentTitle('データの扱い');
  const { signedIn } = useApp();
  return (
    <div className="doc-page">
      <article className="doc">
        <Link to={signedIn ? '/more' : '/login'} className="btn btn-text doc-back">
          <Icon name="back" size={18} />
          戻る
        </Link>
        <h1>データの扱い</h1>
        <p className="doc-lead">
          あなたのノートがどこに置かれ、誰が読めて、何があなたの手元で決められるのかをまとめています。都合の悪いことも含めて、正直に書いています。
        </p>

        <section className="doc-summary card">
          <h2>まとめ</h2>
          <ul>
            <li>
              <strong>どのノートをAIに渡すかは、あなたがフォルダごとに決めます。</strong>
              初期設定では、外部のAIには何も送りません。
            </li>
            <li>
              運営者は、このサービス内のノートを<strong>技術的には読める</strong>
              状態にあります。ただし、アプリにノートを読む機能はなく、運営者は読みません。
            </li>
            <li>
              それが気になる場合は、<strong>自分でこのアプリを動かす</strong>
              ことができます(無料のCloudflareアカウントでも動きます)。
            </li>
            <li>
              サインインやAIによる読み書きは<strong>セキュリティログ</strong>
              に残り、あなたも確認できます。
            </li>
          </ul>
        </section>

        <section className="doc-highlight">
          <h2>
            <Icon name="shield" size={22} />
            AIに渡すかどうかは、あなたが決める
          </h2>
          <p>
            このアプリでは、<strong>フォルダごと・ノートごとに</strong>
            「AIにどこまで見せるか」を設定できます(設定 → AIポリシー)。
          </p>
          <table className="doc-table">
            <thead>
              <tr>
                <th>設定</th>
                <th>意味</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>外部AIにも送れる</td>
                <td>Claude などの外部AIや、つないだAIエージェントに見せてよい</td>
              </tr>
              <tr>
                <td>ローカルAIのみ(初期値)</td>
                <td>サーバーの外には出さない。外部のAIエージェントからは見えない</td>
              </tr>
              <tr>
                <td>AIに送らない</td>
                <td>どのAIにも使わない</td>
              </tr>
            </tbody>
          </table>
          <ul>
            <li>
              「仕事のメモはAIに整理してほしいけれど、日記は絶対に出したくない」といった線引きを、自分で決められます。
            </li>
            <li>
              個別のノートに <code>sensitivity: secret</code> や <code>ai: none</code>{' '}
              を書けば、フォルダの設定より厳しくできます。
            </li>
            <li>
              外部AIに送る前に、APIキーやパスワード、電話番号などを検出し、確認・伏せ字・送信停止のいずれかを行います。検出はサーバー内で行い、そのために外部へ送ることはありません(検出は補助で、完全ではありません)。
            </li>
            <li>
              AIエージェントがどのノートを読んだか・書いたかは、セキュリティログでいつでも確認できます。
            </li>
          </ul>
        </section>

        <section>
          <h2>運営者はノートを読めるのか</h2>
          <p>
            <strong>このサービス内に保存したノートは、暗号化していません。</strong>
            サーバー側で全文検索・AIによる整理・AIエージェントとの連携を行うためです。データベースは
            Cloudflare
            によって保存時に暗号化されていますが、運営者(サーバーを動かしている人)は技術的には読める状態にあります。
          </p>
          <p>そのうえで、次のように運用しています。</p>
          <ul>
            <li>
              アプリには、運営者や管理者が他人のノートを開く機能がありません。管理者にできるのは、招待の作成、アカウントの削除、リカバリーコードの再発行だけです。
            </li>
            <li>管理者の操作はすべてセキュリティログに記録されます。</li>
            <li>
              データベースへの直接のアクセスは、運営者本人だけが、2段階認証と最小限の権限で行います。障害対応や、あなたから依頼があった場合を除いて、ノートの中身を見ることはありません。
            </li>
          </ul>
          <p className="notice notice-info">
            多くのメモアプリ(Notion、Google Keep、Evernote
            など)も同じ考え方で、運営側は技術的には読める状態です。「運営者にも絶対に読めないこと」が必要な場合は、自分で運用してください。
          </p>
        </section>

        <section>
          <h2>保存先の選び方</h2>
          <table className="doc-table">
            <thead>
              <tr>
                <th>保存先</th>
                <th>読める人</th>
                <th>向いている人</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>このサービス内(初期値)</td>
                <td>あなた、運営者(技術的に)、Cloudflare</td>
                <td>何も用意せずに使いたい</td>
              </tr>
              <tr>
                <td>自分のGitHub</td>
                <td>あなた、GitHub、運営者(検索用のコピーを技術的に)</td>
                <td>履歴をGitHubに持ち、手元のエディタでも編集したい</td>
              </tr>
              <tr>
                <td>自分で運用</td>
                <td>あなただけ(自分のサーバーやCloudflareアカウント)</td>
                <td>運営者を信頼したくない</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">
            GitHub
            保存でも、検索とAIのために最新のノートの写しがこのサービスのデータベースに作られます。運営者から見えにくくする方法ではなく、ノートと履歴を自分のリポジトリに持っておくための選択肢です。保存先は
            設定 → 保存先 からいつでも切り替えられます。
          </p>
        </section>

        <section>
          <h2>記録しているもの・していないもの</h2>
          <table className="doc-table">
            <thead>
              <tr>
                <th>記録している</th>
                <th>記録していない</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  ユーザー名、パスキーの公開鍵、サインインや設定変更の記録、AIが読み書きしたノートの
                  <strong>パス</strong>
                </td>
                <td>メールアドレス、本名、パスワード(そもそもありません)</td>
              </tr>
              <tr>
                <td>接続元のIPアドレス(標準の設定ではハッシュ化し、元のアドレスには戻せない形)</td>
                <td>AIが読んだノートの本文、AIの検索語、トークンの値</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">
            セキュリティログは標準の設定で約400日保存し、その後自動で削除します。設定 →
            セキュリティログ で自分の記録を確認できます。
          </p>
        </section>

        <section>
          <h2>外部AIに送られるもの</h2>
          <p>外部のAI(Anthropic、OpenAI など)にデータが出るのは、次の場合だけです。</p>
          <ol>
            <li>
              「ノートに質問」で外部AIを使ったとき:質問文と、関連するノートのうち「外部AIにも送れる」ものの一部
            </li>
            <li>あなたが接続を許可したAIエージェントが、「外部AIにも送れる」ノートを読んだとき</li>
          </ol>
          <p>送信の記録は 設定 → AI送信ログ で確認できます(送った内容そのものは記録しません)。</p>
        </section>

        <section>
          <h2>持ち出しと削除</h2>
          <ul>
            <li>設定 → データ・アカウント から、全ノートをいつでもエクスポートできます。</li>
            <li>
              アカウントを削除すると、このサービス内のノート・履歴・検索インデックス・AIエージェント・トークンをすべて削除します(GitHub
              のリポジトリはそのまま残ります)。
            </li>
            <li>
              データベースの障害に備えたバックアップ(最大30日分)から、削除したデータが完全に消えるまでには時間がかかります。
            </li>
          </ul>
        </section>
      </article>
    </div>
  );
}
