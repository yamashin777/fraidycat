// background.js（Service Worker）からのメッセージを受け取り、
// parser.js の parseRSS() / parseFeedTitle() でXML/JSONをパースして返す。
// Service WorkerにはDOMParserが無いため、DOM付きのこのオフスクリーン
// ドキュメントで代わりにパースを行う。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false; // 自分宛でなければ無視

  if (message.type === 'parseFeed') {
    try {
      const result = parseRSS(message.raw);
      sendResponse({ ok: true, data: result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false; // 同期応答
  }

  if (message.type === 'parseFeedTitle') {
    try {
      const title = parseFeedTitle(message.raw);
      sendResponse({ ok: true, data: title });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  }

  return false;
});
