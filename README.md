# SnapRoom

招待URLから参加する、ひとつの共有フォトアルバムです。ルーム作成やルーム切り替えはありません。

招待された人はURLを開くとそのまま参加できます。サイト内のカメラで撮影した写真は、プレビューと「撮り直す」「写真を投稿する」の選択を経て共有アルバムへ投稿されます。投稿後はほかの参加者の画面にもリアルタイムで反映されます。

## Supabaseの初期設定

1. Supabaseでプロジェクトを作成します。
2. Authentication設定で匿名サインイン（Anonymous Sign-Ins）を有効にします。匿名ユーザーは画面上の登録操作なしで作成されますが、Supabase AuthのユーザーIDを使って参加権限を管理します。
3. SQL Editorで `supabase-schema.sql` を実行します。以前のSnapRoomの `photos` テーブルがある場合、その写真情報は新しい共有アルバムへ移行されます。以前のルーム用テーブルはデータ保全のため残りますが、クライアントから読めないようにします。
4. Project Settings > APIからProject URLとpublishable key（または旧anon key）を確認し、`src/config.js` の値を設定します。

ブラウザに置けるのはpublishable/anon keyだけです。`service_role` や `secret` keyは設定しないでください。

## 招待URLを作成する

Supabase SQL Editorで次を実行します。

```sql
select public.create_album_invite() as invite_token;
```

結果に表示されたトークンをデプロイ先URLの `invite` パラメーターに付けます。

```text
https://your-site.example/#invite=ここにトークン
```

招待URLを開くと画面に招待QRコードが表示されます。リンクを知っている人は参加できるため、招待URLの転送先にも閲覧・投稿を許可する前提で共有してください。トークンはURLのフラグメントに含めるためHTTPリクエストには送られません。トークンはデータベースにハッシュで保存し、ブラウザではURLから取り除いた後、参加者のタブ内に保持します。

招待URLを無効にするにはSQL Editorで次を実行します。

```sql
select public.revoke_album_invite('無効にするトークン');
```

これはそのリンクからの新規参加を止めます。すでに参加した人はアルバムに残ります。参加者を個別に外す管理画面はまだありません。

## ローカルで起動する

Node.js 20.19以上、または22.12以上を使います。アプリフォルダで次を実行してください。

```bash
npm install
npm run dev
```

## GitHub PagesでHTTPS公開する

このリポジトリにはGitHub Actionsの公開ワークフローが含まれています。GitHubにリポジトリを作り、このアプリフォルダ内のファイルをリポジトリのルートへpushします。その後、GitHubの **Settings > Pages > Build and deployment > Source** で **GitHub Actions** を選びます。

`main` ブランチへpushすると自動でビルド・公開されます。公開URLは通常 `https://<GitHubユーザー名>.github.io/<リポジトリ名>/` です。アカウント用の `<ユーザー名>.github.io` リポジトリを使う場合はルートURLになります。Viteのbase pathはGitHub Actionsで自動設定されます。

GitHub Pagesではサイトがインターネット上に公開されます。ソースコードも公開する場合は、リポジトリに秘密情報を入れないでください。Supabaseのpublishable/anon keyはブラウザ向け公開キーですが、`service_role` や `secret` keyは絶対に追加しないでください。

スマートフォンのカメラを使うにはHTTPSが必要です（localhostは開発時の例外です）。公開後に招待URLを作るときは、表示されたURLに `#invite=<トークン>` を付けます。

## データ・アクセスについて

- アルバムや写真の読み取り、投稿、Storage上の画像取得は参加者に限定されます。
- 写真バケットは非公開です。ギャラリー表示には参加者向けの有効期限付きURLを使います。
- 招待URLを転送された相手も参加できます。個人単位の本人確認や参加者管理はありません。
- ブラウザからのカメラ利用には、利用者のカメラ許可が必要です。
- 初回のSupabaseセットアップ後、Storageの `photo-wall` バケットに別の広いアクセス許可ポリシーがないことを確認してください。

## トラブルシューティング

- **招待リンクが無効と表示される：** SQL Editorで新しいトークンを作り、そのURLを開いてください。期限切れまたは無効化済みのリンクは使えません。
- **匿名ログインのエラーが出る：** Supabase Authenticationで匿名サインインが有効か確認してください。
- **写真を投稿できない：** `src/config.js` と `supabase-schema.sql` の実行結果を確認してください。
- **写真がほかの端末に反映されない：** Realtimeで `shared_photos` が `supabase_realtime` publicationに含まれていることを確認してください。
- **カメラが起動しない：** HTTPSでアクセスし、ブラウザとOSのカメラ権限を確認してください。
