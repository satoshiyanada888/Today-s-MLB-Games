# Today's MLB Games

今日のMLB試合とスコアを表示するシンプルなWebアプリです。  
[MLB Stats API](https://statsapi.mlb.com/)（公開・APIキー不要）を使用しています。

## 表示内容

- チーム名（アウェイ / ホーム）
- スコア
- 試合終了時は勝者をハイライト表示

## 起動方法

ローカルでHTTPサーバーを立てて開いてください（`file://` ではCORSのためAPIが呼べない場合があります）。

```bash
# Python 3
python3 -m http.server 8080

# Node.js (npx)
npx -y serve -l 8080
```

ブラウザで **http://localhost:8080** を開きます。

## ファイル構成

- `index.html` - ページ構造
- `style.css` - レイアウト・スタイル
- `app.js` - API取得と表示ロジック

## 注意

- オフシーズンや試合のない日は「今日の試合はありません」と表示されます。
- データは MLB Stats API に依存し、利用は [MLBの利用規約](http://gdx.mlb.com/components/copyright.txt) に従います。
