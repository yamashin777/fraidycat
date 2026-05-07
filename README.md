[README.md](https://github.com/user-attachments/files/27460637/README.md)# Fraidycat Clone

YouTubeチャンネルやRSSフィードをまとめてチェックできるWebアプリです。オリジナルの[Fraidycat](https://fraidyc.at/)にインスパイアされ、Chrome拡張機能のサポート終了に伴い独自に開発しました。

## 特徴

- **チャンネル・RSS一括管理** — YouTube・ブログ・Podcastなど形式を問わず登録可能
- **新着順タイムライン** — 全チャンネルの動画を投稿日時でフラットに表示
- **動画時間の自動取得** — YouTube Data API v3を使って再生時間を一括取得
- **ライブ・ショート判別** — ライブ配信（赤）・ショート動画（青グレー）を色分け表示
- **タグ・メモ管理** — チャンネルにタグとメモを登録して整理
- **JSONエクスポート／インポート** — 端末間でデータを共有
- **スマホ対応** — iPhoneのSafariやBraveでも快適に動作
- **ダークモード対応**

## 使い方

### Webアプリとして使う（GitHub Pages）

1. `fraidycat.html` を `index.html` にリネームしてGitHubリポジトリにアップロード
2. Settings → Pages → Deploy from a branch（main）を設定
3. `https://ユーザー名.github.io/リポジトリ名` でアクセス

### ローカルで使う

`fraidycat.html` をブラウザで直接開くだけで動作します。

### Chrome拡張機能として使う

1. `fraidycat-extension.zip` を解凍
2. Chromeで `chrome://extensions` を開く
3. 「デベロッパーモード」をONにする
4. 「パッケージ化されていない拡張機能を読み込む」→ 解凍した `fraidycat-ext` フォルダを選択

## ファイル構成

```
fraidycat.html              # メインWebアプリ（単一HTMLファイル）
fraidycat-extension.zip     # Chrome拡張機能版
├── manifest.json           # 拡張機能の設定（Manifest V3）
├── popup.html              # ポップアップUI
├── background.js           # バックグラウンド自動更新・通知
└── icons/                  # アイコン画像
```

## 主な機能

### フォローの管理

| 操作 | 方法 |
|------|------|
| 追加 | 「+ 追加」ボタン → URL・名前・タグ・メモを入力 |
| 一括インポート | 「↑ 一括インポート」→ テキスト形式で複数登録 |
| 編集 | チャンネルをクリックして展開 → チャンネル名・タグ・メモ・更新頻度を編集 |
| 削除 | チャンネル右端の「✕」をクリック |

### テキスト一括インポートの形式

```
#タグ名
https://www.youtube.com/feeds/videos.xml?channel_id=XXXX チャンネル名
https://www.youtube.com/feeds/videos.xml?channel_id=YYYY チャンネル名

#別のタグ
https://example.com/feed ブログ名
```

### 表示モード

| モード | 説明 |
|--------|------|
| 📋 チャンネル順 | 全チャンネルを最新投稿日時順でカード表示 |
| 🕐 新着順 | 全動画を投稿日時順でタイムライン表示 |
| ⏬ 長い順 | 再生時間の長い動画から順に表示 |
| ⏫ 短い順 | 再生時間の短い動画から順に表示 |
| 🆕 登録新しい順 | 最近登録したチャンネルを上に表示 |
| 🕰 登録古い順 | 最初に登録したチャンネルを上に表示 |

### YouTube Data API v3の設定（動画時間取得に必要）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「ライブラリ」→ `YouTube Data API v3` を有効化
3. 「認証情報」→「APIキーを作成」→ キーをコピー
4. アプリの「🔑 APIキー」ボタンからキーを登録
5. 「▶ 時間一括取得」で全動画の再生時間を取得

> **無料枠**: 1日1万リクエストまで無料

### PC ↔ スマホのデータ共有

1. PCで「↓ エクスポート」→ JSONファイルをダウンロード
2. LINEやメールでスマホに送信
3. スマホのブラウザで「↑ インポート」→ JSONファイルを選択

## 動画の色分け

| バッジ色 | 意味 |
|---------|------|
| 🔴 赤 `Live` | ライブ配信中・予定、またはタイトルに「LIVE」「生放送」を含む |
| 🔵 青グレー `[ショート]` | YouTubeショート動画（`/shorts/` URL形式） |
| ⬜ グレー | 通常の動画 |

## 更新頻度の設定

各チャンネルに更新頻度を設定できます。自動フェッチのタイミングに使用されます。

| 設定 | チェック間隔 |
|------|------------|
| リアルタイム | 5分ごと |
| 毎日 | 24時間ごと |
| 毎週 | 7日ごと |
| 毎月 | 30日ごと |
| 毎年 | 365日ごと |

## 技術仕様

- **フロントエンド**: 純粋なHTML/CSS/JavaScript（フレームワーク不使用）
- **RSSフェッチ**: CORSプロキシ（allorigins.win / corsproxy.io）を利用
- **データ保存**: `localStorage`（Webアプリ）/ `chrome.storage.local`（拡張機能）
- **YouTube API**: Google YouTube Data API v3（動画時間・ライブ状態の取得）
- **同時フェッチ数**: 最大3件（ブラウザ負荷対策）

## 注意事項

- RSSフェッチはCORSプロキシ経由のため、プロキシサービスの状態に依存します
- YouTube Data API v3のキーはブラウザのローカルストレージに保存されます
- GitHub Pagesで公開する場合、URLが公開状態になります（フォローリストは端末内に保存）

