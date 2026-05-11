/**
 * アフィリエイトリンク生成ヘルパー
 * - 楽天: 楽天Web Service API のアフィID注入 or フォールバック検索URL
 * - Amazon: アソシエイトID付き検索URL生成（kicchin-shinu は deskscape-22 流用）
 */

const AMAZON_ASSOCIATE_ID =
  import.meta.env.AMAZON_ASSOCIATE_ID ||
  process.env.AMAZON_ASSOCIATE_ID ||
  'deskscape-22'; // 流用中（kicchin 用 ID を新規取得したらここを書き換え）

const RAKUTEN_AFFILIATE_ID =
  import.meta.env.RAKUTEN_AFFILIATE_ID ||
  process.env.RAKUTEN_AFFILIATE_ID ||
  '';

/**
 * Amazon.co.jp 検索リンク（アソシエイトID付き）
 */
export function buildAmazonSearchUrl(keyword: string): string {
  const params = new URLSearchParams({
    k: keyword,
    tag: AMAZON_ASSOCIATE_ID,
  });
  return `https://www.amazon.co.jp/s?${params.toString()}`;
}

/**
 * Amazon.co.jp 商品ページリンク（ASIN指定、アソシエイトID付き）
 */
export function buildAmazonProductUrl(asin: string): string {
  return `https://www.amazon.co.jp/dp/${asin}?tag=${AMAZON_ASSOCIATE_ID}`;
}

/**
 * 楽天市場検索リンク（フォールバック用、API取得失敗時）
 */
export function buildRakutenSearchUrl(keyword: string): string {
  const encoded = encodeURIComponent(keyword);
  const base = `https://search.rakuten.co.jp/search/mall/${encoded}/`;
  if (RAKUTEN_AFFILIATE_ID) {
    return `${base}?af_id=${RAKUTEN_AFFILIATE_ID}`;
  }
  return base;
}
