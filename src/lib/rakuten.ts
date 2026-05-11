/**
 * 楽天ウェブサービスAPI クライアント
 * Build time only — Astro静的ビルド時にのみ呼び出される
 */

const APP_ID = import.meta.env.RAKUTEN_APP_ID || process.env.RAKUTEN_APP_ID;
const AFFILIATE_ID = import.meta.env.RAKUTEN_AFFILIATE_ID || process.env.RAKUTEN_AFFILIATE_ID;
const ACCESS_KEY = import.meta.env.RAKUTEN_ACCESS_KEY || process.env.RAKUTEN_ACCESS_KEY;

// 2026-02-10 楽天Web Service API移行で新エンドポイント・新認証に変更
// 新: https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601
//     + accessKey 必須 + Origin ヘッダー必須
const BASE_URL = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
// 楽天デベロッパー側のアプリ登録URLと一致が必須（変更したら楽天側も更新する）
const ORIGIN_HEADER = import.meta.env.RAKUTEN_ORIGIN || process.env.RAKUTEN_ORIGIN || 'https://kicchin-shinu.com';

export interface RakutenItem {
  itemName: string;
  itemPrice: number;
  itemUrl: string;        // アフィリエイトID付与済みURL
  affiliateUrl?: string;  // 楽天が直接提供するアフィリリンク
  imageUrl: string;       // 商品画像（128x128 / 600x600 対応）
  imageUrlLarge: string;
  shopName: string;
  reviewAverage: number;
  reviewCount: number;
}

interface SearchOptions {
  keyword: string;
  hits?: number;       // 取得件数（1-30）
  minPrice?: number;
  maxPrice?: number;
  sort?: '+itemPrice' | '-itemPrice' | 'standard' | '-reviewCount' | '-reviewAverage';
  itemCode?: string;   // 特定商品コード指定時
  shopCode?: string;
  ngKeyword?: string;  // 除外キーワード（デフォルト: 中古 ジャンク）
  includeUsed?: boolean; // 中古を含めるか（デフォルト: false）
}

/**
 * グローバルなレート制限（楽天: 1リクエスト/秒）と同一キーワードのキャッシュ
 * Astro静的ビルド時に多数のProductBoxを並列処理するため、
 * モジュールレベルで状態を持つ
 */
const responseCache = new Map<string, any[]>();
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100; // 1.1秒（安全マージン込み）
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * リクエスト間隔を確保するスロットラー
 */
let throttlePromise: Promise<void> = Promise.resolve();
function throttledWait(): Promise<void> {
  throttlePromise = throttlePromise.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - elapsed);
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();
  });
  return throttlePromise;
}

/**
 * キーワードのサニタイズ
 * 楽天 API が拒否する「1文字単語」を除去
 */
function sanitizeKeyword(keyword: string): string {
  return keyword
    .split(/\s+/)
    .filter(w => w.length >= 2 || /[぀-ゟ゠-ヿ一-鿿]/.test(w))
    .join(' ')
    .trim();
}

/**
 * 楽天市場API直接呼び出し（内部用、キャッシュ + スロットル + 429リトライ付き）
 */
async function callRakutenAPI(options: SearchOptions, useNGKeyword: boolean): Promise<any[]> {
  const sanitized = sanitizeKeyword(options.keyword);
  const params = new URLSearchParams({
    applicationId: APP_ID!,
    format: 'json',
    keyword: sanitized,
    hits: String(options.hits ?? 1),
    sort: options.sort ?? '-reviewCount',
    formatVersion: '2',
  });

  if (options.itemCode) params.set('itemCode', options.itemCode);
  if (options.shopCode) params.set('shopCode', options.shopCode);
  if (AFFILIATE_ID) params.set('affiliateId', AFFILIATE_ID);
  if (ACCESS_KEY) params.set('accessKey', ACCESS_KEY);

  if (useNGKeyword && !options.includeUsed) {
    const ngKeyword = options.ngKeyword ?? '中古';
    params.set('NGKeyword', ngKeyword);
  }

  const cacheKey = params.toString();
  if (responseCache.has(cacheKey)) {
    return responseCache.get(cacheKey)!;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttledWait();

    try {
      const res = await fetch(`${BASE_URL}?${params.toString()}`, {
        headers: { 'Origin': ORIGIN_HEADER },
      });

      if (res.status === 429) {
        const backoff = (attempt + 1) * 2000;
        console.warn(`[Rakuten] レート制限 429 (attempt ${attempt + 1}/3) → ${backoff}ms 待機`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 200); } catch {}
        console.warn(`[Rakuten] APIエラー: HTTP ${res.status} | keyword="${options.keyword}" | body=${body}`);
        responseCache.set(cacheKey, []);
        return [];
      }

      const data = await res.json();
      const items = data.Items ?? [];
      responseCache.set(cacheKey, items);
      return items;
    } catch (e) {
      console.warn(`[Rakuten] 取得失敗 (attempt ${attempt + 1}/3):`, e);
    }
  }

  console.warn('[Rakuten] 3回失敗、空配列を返す');
  responseCache.set(cacheKey, []);
  return [];
}

/**
 * キーワードで楽天市場を検索
 * 段階的フォールバック：
 *   1. 元キーワード × 中古除外
 *   2. 元キーワード × 中古含む
 *   3. 末尾1単語ドロップ × 中古除外
 *   4. 末尾1単語ドロップ × 中古含む
 */
export async function searchRakutenItems(options: SearchOptions): Promise<RakutenItem[]> {
  if (!APP_ID) {
    console.warn('[Rakuten] RAKUTEN_APP_ID が未設定。商品取得をスキップします。');
    return [];
  }

  const sanitized = sanitizeKeyword(options.keyword);
  const words = sanitized.split(/\s+/);
  let items: any[] = [];

  items = await callRakutenAPI(options, true);

  if (items.length === 0 && !options.includeUsed) {
    console.warn(`[Rakuten] 「${sanitized}」中古除外で0件、フォールバック検索`);
    items = await callRakutenAPI(options, false);
  }

  if (items.length === 0 && words.length > 1) {
    const shortened = words.slice(0, -1).join(' ');
    console.warn(`[Rakuten] 「${sanitized}」全件0件、キーワード短縮で再試行: 「${shortened}」`);
    items = await callRakutenAPI({ ...options, keyword: shortened }, true);
    if (items.length === 0 && !options.includeUsed) {
      items = await callRakutenAPI({ ...options, keyword: shortened }, false);
    }
  }

  if (items.length === 0) return [];

  let filtered = items;
  if (options.minPrice || options.maxPrice) {
    const inRange = items.filter((item: any) => {
      if (options.minPrice && item.itemPrice < options.minPrice) return false;
      if (options.maxPrice && item.itemPrice > options.maxPrice) return false;
      return true;
    });
    if (inRange.length > 0) {
      filtered = inRange;
    } else {
      console.warn(`[Rakuten] 「${sanitized}」価格レンジ ${options.minPrice}-${options.maxPrice} に該当なし、フォールバック`);
    }
  }

  return filtered.map((item: any) => ({
    itemName: item.itemName,
    itemPrice: item.itemPrice,
    itemUrl: item.itemUrl,
    affiliateUrl: item.affiliateUrl,
    imageUrl: item.mediumImageUrls?.[0] ?? '',
    imageUrlLarge: item.mediumImageUrls?.[0]?.replace('?_ex=128x128', '?_ex=600x600') ?? '',
    shopName: item.shopName,
    reviewAverage: item.reviewAverage ?? 0,
    reviewCount: item.reviewCount ?? 0,
  }));
}

/**
 * キーワードで1件だけ取得（ProductBox用）
 */
export async function findRakutenItem(keyword: string, opts?: Partial<SearchOptions>): Promise<RakutenItem | null> {
  const items = await searchRakutenItems({ keyword, hits: 5, ...opts });
  return items[0] ?? null;
}
