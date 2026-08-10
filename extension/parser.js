/*
 * parser.js — RSS/Atomフィードのパース処理（DOMParser依存）
 *
 * app.js本体（ページ／タブとして動くUI側）と、Chrome拡張機能の
 * オフスクリーンドキュメント（Service WorkerにはDOMParserが無いための
 * 代替実行環境）の両方から読み込まれる共通モジュール。
 * DOM要素やグローバルUI状態には一切依存しない純粋な関数のみを置く。
 */

/* 日付文字列をSafariでも確実にパース */
function parseDate(str){
  if(!str) return null;
  const s = str.trim();

  // パターン1: 標準パース（Chrome/Firefox）
  let d = new Date(s);
  if(!isNaN(d.getTime())) return d;

  // パターン2: +09:00 形式のタイムゾーンをUTCに手動変換
  // 例: 2026-05-03T14:30:00+09:00
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/);
  if(m1){
    const [,yr,mo,dy,hr,mn,sc,sgn,ohh,omm] = m1;
    const offsetMin = (parseInt(ohh)*60 + parseInt(omm)) * (sgn==='+' ? 1 : -1);
    const utcMs = Date.UTC(+yr,+mo-1,+dy,+hr,+mn,+sc) - offsetMin*60000;
    d = new Date(utcMs);
    if(!isNaN(d.getTime())) return d;
  }

  // パターン3: タイムゾーン除去してパース
  // 例: 2026-05-03T14:30:00
  const stripped = s.replace(/[+-]\d{2}:\d{2}$/, '').replace('Z','').replace('T',' ');
  d = new Date(stripped);
  if(!isNaN(d.getTime())) return d;

  // パターン4: RFC 2822 (RSS pubDate) 例: Sat, 03 May 2026 14:30:00 +0900
  // Safariでは問題ないことが多いが念のため
  const m4 = s.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})/);
  if(m4){
    d = new Date(s.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3'));
    if(!isNaN(d.getTime())) return d;
  }

  return null;
}

function parseFeedTitle(xmlText){
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const isAtom = !!doc.querySelector('feed');
  if(isAtom){
    return doc.querySelector('feed > title')?.textContent?.trim() || '';
  } else {
    return doc.querySelector('channel > title')?.textContent?.trim() || '';
  }
}

/* XMLノードから名前空間を無視してタグ名で最初の要素を取る */
function getEl(node, ...names){
  for(const name of names){
    // ローカル名だけで検索（名前空間を無視）
    const found = node.getElementsByTagNameNS('*', name)[0]
                || node.getElementsByTagName(name)[0];
    if(found) return found;
  }
  return null;
}

function parseRSS(raw){
  // rss2json format
  if(raw && raw.rss2json){
    const {feed, items} = raw.rss2json;
    return {
      feedTitle: feed?.title || '',
      posts: (items||[]).slice(0,5).map(it=>({
        title: it.title || '(無題)',
        link: it.link || '#',
        date: it.pubDate ? new Date(it.pubDate) : null,
        duration: null,
      }))
    };
  }
  // XML string
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'application/xml');
  const isAtom = !!(doc.getElementsByTagNameNS('*','feed')[0] || doc.getElementsByTagName('feed')[0]);
  const posts = [];
  let feedTitle = '';

  if(isAtom){
    feedTitle = getEl(doc,'feed')?.getElementsByTagNameNS('*','title')[0]?.textContent?.trim()
             || doc.getElementsByTagName('title')[0]?.textContent?.trim() || '';

    const entries = [...(doc.getElementsByTagNameNS('*','entry').length
      ? doc.getElementsByTagNameNS('*','entry')
      : doc.getElementsByTagName('entry'))];

    entries.forEach(e=>{
      const title = getEl(e,'title')?.textContent?.trim() || '(無題)';

      // link: <link rel="alternate" href="..."> or <link href="...">
      const linkEls = [...e.getElementsByTagName('link'), ...e.getElementsByTagNameNS('*','link')];
      const linkEl = linkEls.find(l=>l.getAttribute('rel')==='alternate') || linkEls[0];
      const link = linkEl?.getAttribute('href') || linkEl?.textContent?.trim() || '#';

      // 投稿日: <published> を優先、なければ <updated>
      const publishedEl = getEl(e,'published');
      const updatedEl   = getEl(e,'updated');
      const dateStr = (publishedEl || updatedEl)?.textContent?.trim() || '';
      const date = parseDate(dateStr);
      // <updated>（フィード側の最終更新日時）も別途保持しておく。
      // 配信予定が長期間放置されているかどうかの判定に使う。
      const rssUpdatedStr = updatedEl?.textContent?.trim() || '';
      const rssUpdated = rssUpdatedStr ? parseDate(rssUpdatedStr) : null;

      // YouTube duration: <yt:duration seconds="N"> -> seconds属性
      // またはテキストコンテンツ
      let duration = null;
      const durEl = getEl(e,'duration');
      if(durEl){
        const secAttr = durEl.getAttribute('seconds');
        if(secAttr){
          duration = parseInt(secAttr);
        } else {
          // itunes style: "H:MM:SS" / "M:SS"
          const txt = durEl.textContent?.trim();
          if(txt && txt.includes(':')){
            const parts = txt.split(':').map(Number);
            duration = parts.length===3 ? parts[0]*3600+parts[1]*60+parts[2] : parts[0]*60+(parts[1]||0);
          } else if(txt){
            duration = parseInt(txt) || null;
          }
        }
      }

      // 動画説明文（<media:description>）。要約機能の入力に使う。
      const description = getEl(e,'description')?.textContent?.trim() || '';

      posts.push({title, link, date, duration, rssUpdated, description});
    });
  } else {
    feedTitle = doc.querySelector('channel > title')?.textContent?.trim()
             || getEl(doc,'title')?.textContent?.trim() || '';

    const items = [...doc.getElementsByTagName('item')];
    items.forEach(e=>{
      const title = getEl(e,'title')?.textContent?.trim() || '(無題)';
      const link = getEl(e,'link')?.textContent?.trim()
                || getEl(e,'guid')?.textContent?.trim() || '#';
      const dateStr = (getEl(e,'pubDate') || getEl(e,'date'))?.textContent?.trim() || '';

      const itunesDur = getEl(e,'duration')?.textContent?.trim() || null;
      let duration = null;
      if(itunesDur){
        if(itunesDur.includes(':')){
          const parts = itunesDur.split(':').map(Number);
          duration = parts.length===3 ? parts[0]*3600+parts[1]*60+parts[2] : parts[0]*60+(parts[1]||0);
        } else {
          duration = parseInt(itunesDur) || null;
        }
      }
      posts.push({title, link, date: parseDate(dateStr), duration});
    });
  }

  posts.sort((a,b)=> (b.date||0) - (a.date||0));
  return {feedTitle, posts: posts.slice(0,5)};
}
