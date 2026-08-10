/*
 * fetcher.js — CORSプロキシ経由でのRSS/Atomフィード取得処理
 *
 * app.js本体（ページ／タブ側）と、Chrome拡張機能のService Worker
 * (background.js、classic scriptとしてimportScripts経由で読み込む)
 * の両方から使う共通モジュール。
 *
 * ページ側ではfetchRSSRaw()の後にparseRSS()（parser.js、DOMParser使用）
 * をそのまま呼べるが、Service WorkerにはDOMParserが無いため、
 * background.js側はfetchRSSRaw()で取得した生データをオフスクリーン
 * ドキュメントに渡してパースする（parseFeedViaOffscreen()）。
 *
 * loadingCount / updateFetchStatus はページ側UIの状態表示用で、
 * Service Workerには存在しないため、存在する場合のみ呼び出す。
 */

const PROXIES = [
  async url => {
    const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw new Error(`allorigins HTTP ${r.status}`);
    const j = await r.json();
    const t = j.contents || '';
    if(!t) throw new Error('allorigins: empty');
    return t;
  },
  async url => {
    const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, {signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw new Error(`corsproxy HTTP ${r.status}`);
    return await r.text();
  },
  async url => {
    const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`, {signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw new Error(`rss2json HTTP ${r.status}`);
    const j = await r.json();
    if(j.status !== 'ok') throw new Error('rss2json: ' + (j.message||'error'));
    return {rss2json: j};
  },
  async url => {
    const r = await fetch(`https://feedproxy.google.com/${encodeURIComponent(url)}`, {signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw new Error(`feedproxy HTTP ${r.status}`);
    return await r.text();
  },
];
const PROXY_NAMES = ['allorigins', 'corsproxy', 'rss2json', 'feedproxy'];
let lastUsedProxy = '';

// Chrome拡張機能の特権コンテキスト（Service Worker／chrome-extension://で開いた
// ページ）で実行中かどうか。拡張機能はmanifest.jsonのhost_permissionsにより、
// 通常のWebページと違ってCORSを気にせず直接fetchできる（要host_permissions）。
// 普通のWebページ（GitHub Pages版）では常にfalseになり、従来通りプロキシ必須。
const isExtensionContext = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

const proxyCooldownUntil = [0, 0, 0, 0];
const PROXY_COOLDOWN_MS = 5 * 60 * 1000; // 5分
let proxyRotation = 0; // チャンネルごとに開始プロキシをずらす

// エラーメッセージを分かりやすい日本語に整形（429→レート制限など）
function humanizeProxyError(msg){
  msg = msg || 'エラー';
  if(/\b429\b/.test(msg)) return 'レート制限';
  if(/Failed to fetch|NetworkError|ERR_FAILED/i.test(msg)) return 'ネットワーク失敗';
  if(/timeout|aborted|signal/i.test(msg)) return 'タイムアウト';
  const m = msg.match(/HTTP (\d{3})/);
  if(m){
    if(m[1]==='403') return 'アクセス拒否';
    if(m[1]==='500'||m[1]==='502'||m[1]==='503') return 'サーバーエラー';
    return `エラー(${m[1]})`;
  }
  return msg.length > 24 ? msg.slice(0,24)+'…' : msg;
}

// 直近のフェッチで各プロキシがどうだったか（doFetchがログに使う）
let lastProxyAttempts = [];

// CORSプロキシを介さない直接取得（対応しているサイトのみ成功する）
async function fetchDirect(url){
  const r = await fetch(url, {signal:AbortSignal.timeout(8000), mode:'cors'});
  if(!r.ok) throw new Error(`direct HTTP ${r.status}`);
  return await r.text();
}

async function fetchRSSRaw(url){
  let lastErr;
  const n = PROXIES.length;
  const attempts = []; // {proxy, ok, reason}

  // まずCORSプロキシを使わず直接取得を試す。
  // 対応しているサイト（多くの一般ブログ・ポッドキャストフィードなど）なら、
  // プロキシを経由せず高速かつ直接取得できる。
  // 通常のWebページ（GitHub Pages版）ではYouTubeはCORSに対応しておらず
  // 必ず失敗するとわかっているため、無駄な試行・ログを避けてプロキシへ直行する。
  // ただしChrome拡張機能側（isExtensionContext）はhost_permissionsにより
  // CORS制限を受けずに直接fetchできるため、YouTubeでも直接取得を試す。
  if(isExtensionContext || !/youtube\.com/i.test(url)){
    try{
      lastUsedProxy = 'direct';
      if(typeof loadingCount !== 'undefined' && loadingCount > 0 && typeof updateFetchStatus === 'function') updateFetchStatus();
      const result = await fetchDirect(url);
      attempts.push({proxy:'direct', ok:true});
      lastProxyAttempts = attempts;
      return result;
    }catch(e){
      attempts.push({proxy:'direct', ok:false, reason:humanizeProxyError(e?.message)});
    }
  }

  const now0 = Date.now();

  // 全プロキシが休止中の場合、以前は最も早く明ける1つだけ試してすぐ諦めていたが、
  // どうせ失敗覚悟の状況なので、休止期限が近い順に全プロキシを試してから諦める
  // （休止判定はこちら側の自己申告的なクールダウンであり、実際には空いている
  // 可能性もあるため、無駄でも試す方が成功率が上がる）。
  const available = [];
  for(let i=0; i<n; i++) if(now0 >= proxyCooldownUntil[i]) available.push(i);
  if(available.length === 0){
    const order2 = Array.from({length:n}, (_,i)=>i).sort((a,b)=>proxyCooldownUntil[a]-proxyCooldownUntil[b]);
    for(const i of order2){
      const pname = PROXY_NAMES[i] || `p${i}`;
      lastUsedProxy = pname;
      if(typeof loadingCount !== 'undefined' && loadingCount > 0 && typeof updateFetchStatus === 'function') updateFetchStatus();
      try{
        const r = await PROXIES[i](url);
        attempts.push({proxy:pname, ok:true});
        lastProxyAttempts = attempts;
        return r;
      }catch(e){
        attempts.push({proxy:pname, ok:false, reason:humanizeProxyError(e?.message)});
      }
    }
    lastProxyAttempts = attempts;
    throw new Error(`全プロキシ休止中 — ${attempts.map(a=>`${a.proxy}:${a.reason}`).join(' / ')}`);
  }

  // 優先度順の試行順を組み立てる（feedproxyは常に最後）
  const preferred = [];
  for(let i=0;i<n;i++) if(PROXY_NAMES[i] !== 'feedproxy') preferred.push(i);
  const deprioritized = [];
  for(let i=0;i<n;i++) if(PROXY_NAMES[i] === 'feedproxy') deprioritized.push(i);
  const rot = proxyRotation % (preferred.length || 1);
  proxyRotation++;
  const order = preferred.slice(rot).concat(preferred.slice(0, rot)).concat(deprioritized);
  for(let k=0; k<order.length; k++){
    const i = order[k];
    const pname = PROXY_NAMES[i] || `p${i}`;
    // クールダウン中のプロキシはスキップ（ログには残さない）
    if(Date.now() < proxyCooldownUntil[i]) continue;
    lastUsedProxy = pname;
    if(typeof loadingCount !== 'undefined' && loadingCount > 0 && typeof updateFetchStatus === 'function') updateFetchStatus();
    try{
      const result = await PROXIES[i](url);
      attempts.push({proxy:pname, ok:true});
      lastProxyAttempts = attempts;
      return result; // string or {rss2json:...}
    }catch(e){
      lastErr = e;
      const reason = humanizeProxyError(e?.message);
      attempts.push({proxy:pname, ok:false, reason});
      // レート制限・アクセス拒否・ネットワーク失敗ならそのプロキシを一定時間休ませる
      // （403は特定チャンネルの一時的な問題ではなく、プロキシ側がこの接続元からの
      // アクセスを継続的に拒否しているケースが大半のため、429と同様に休止対象とする）
      if(/\b429\b/.test(e?.message||'') || /\b403\b/.test(e?.message||'') || /Failed to fetch|NetworkError|ERR_FAILED/i.test(e?.message||'')){
        proxyCooldownUntil[i] = Date.now() + PROXY_COOLDOWN_MS;
      }
    }
  }
  lastProxyAttempts = attempts;
  const detail = attempts.map(a=>`${a.proxy}:${a.ok?'OK':a.reason}`).join(' / ');
  throw new Error(detail || '全プロキシ失敗');
}
