#!/usr/bin/env node
/**
 * generate-weekly-report.js
 *
 * Phase 2 週次レポート自動生成。
 * GA4 + GSC API から過去7日のデータを集計し、editorial/reports/YYYY-WXX.md に出力。
 *
 * 使い方:
 *   npm run weekly-report
 *
 * 必要な環境変数 (.env):
 *   GOOGLE_APPLICATION_CREDENTIALS=./secrets/ga4-service-account.json
 *   GA4_PROPERTY_ID=536641008
 *   GSC_SITE_URL=https://deskmori.com
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { google } from 'googleapis';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORTS_DIR = join(ROOT, 'editorial', 'reports');
const POSTS_DIR = join(ROOT, 'src', 'content', 'posts');

// ---------- helpers ----------

const log = {
  ok: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.log(`⚠️  ${msg}`),
  err: (msg) => console.log(`❌ ${msg}`),
  info: (msg) => console.log(`ℹ  ${msg}`),
  head: (msg) => console.log(`\n${msg}`),
  dim: (msg) => console.log(msg),
};

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNum, label: `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}` };
}

function pct(numer, denom) {
  if (!denom) return 'N/A';
  return ((numer / denom) * 100).toFixed(1) + '%';
}

function delta(curr, prev) {
  if (!prev) return curr ? '+∞' : '±0';
  const change = ((curr - prev) / prev) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

function deltaPP(curr, prev) {
  const diff = (curr - prev) * 100;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)} pp`;
}

// ---------- env check ----------

const REQUIRED_ENVS = ['GOOGLE_APPLICATION_CREDENTIALS', 'GA4_PROPERTY_ID', 'GSC_SITE_URL'];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    log.err(`環境変数 ${k} が未設定`);
    process.exit(1);
  }
}

const credPath = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (!existsSync(credPath)) {
  log.err(`サービスアカウント JSON not found: ${credPath}`);
  process.exit(1);
}

// ---------- GA4 ----------
//
// 全クエリで Japan セグメント限定（country = "Japan"）。
// 海外ボット/翻訳経由などの無価値 PV を最初から除外し、CV につながる日本人ユーザーの
// 行動だけを分析・戦略会議の対象にするための方針（2026-05-13 決定）。

const ga4Client = new BetaAnalyticsDataClient({ keyFilename: credPath });
const propertyId = process.env.GA4_PROPERTY_ID;

// 共通フィルタ式: country == Japan
const JAPAN_ONLY = {
  filter: {
    fieldName: 'country',
    stringFilter: { value: 'Japan', matchType: 'EXACT' },
  },
};

// outbound_click イベント + Japan の AND
const OUTBOUND_JAPAN_AND = {
  andGroup: {
    expressions: [
      { filter: { fieldName: 'eventName', stringFilter: { value: 'outbound_click' } } },
      JAPAN_ONLY,
    ],
  },
};

async function fetchSummaryMetrics(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    dimensionFilter: JAPAN_ONLY,
  });
  if (!resp.rows || resp.rows.length === 0) {
    return { pv: 0, uu: 0, avgDuration: 0, bounceRate: 0 };
  }
  const r = resp.rows[0];
  return {
    pv: parseInt(r.metricValues[0].value || 0),
    uu: parseInt(r.metricValues[1].value || 0),
    avgDuration: parseFloat(r.metricValues[2].value || 0),
    bounceRate: parseFloat(r.metricValues[3].value || 0),
  };
}

async function fetchPageBreakdown(startDate, endDate, limit = 20) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
    dimensionFilter: JAPAN_ONLY,
  });
  return (resp.rows || []).map((r) => ({
    path: r.dimensionValues[0].value,
    pv: parseInt(r.metricValues[0].value || 0),
    uu: parseInt(r.metricValues[1].value || 0),
    avgDuration: parseFloat(r.metricValues[2].value || 0),
    bounceRate: parseFloat(r.metricValues[3].value || 0),
  }));
}

async function fetchOutboundClicks(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: OUTBOUND_JAPAN_AND,
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 20,
  });
  return (resp.rows || []).map((r) => ({
    path: r.dimensionValues[0].value,
    clicks: parseInt(r.metricValues[0].value || 0),
  }));
}

// ---------- 戦略系メトリクス（2026-05-16 追加：層2 温度感の数字を補完）----------
//
// 既存の summary は「層1 健康診断（PV/UU/CV）」のみ。
// _docs/07_KPI_PHILOSOPHY.md「ダッシュボード設計」では、層2（温度感）を加えた
// 「数字 3 割・言葉 7 割」が推奨されており、以下 4 関数で層2 数字部分を補完する。
//
// - 流入元内訳 → サイトの「発見されかた」を可視化
// - デバイス別 → 読者の利用シーン推定
// - 時間帯別 → 読者の生活リズムとの整合性
// - 再訪率 → サイト愛着度の核（最重要）

async function fetchTrafficSources(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'sessions' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    dimensionFilter: JAPAN_ONLY,
    limit: 10,
  });
  return (resp.rows || []).map((r) => ({
    channel: r.dimensionValues[0].value || '(not set)',
    pv: parseInt(r.metricValues[0].value || 0),
    uu: parseInt(r.metricValues[1].value || 0),
    sessions: parseInt(r.metricValues[2].value || 0),
  }));
}

async function fetchDeviceBreakdown(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    dimensionFilter: JAPAN_ONLY,
  });
  return (resp.rows || []).map((r) => ({
    device: r.dimensionValues[0].value || '(not set)',
    pv: parseInt(r.metricValues[0].value || 0),
    uu: parseInt(r.metricValues[1].value || 0),
    avgDuration: parseFloat(r.metricValues[2].value || 0),
    bounceRate: parseFloat(r.metricValues[3].value || 0),
  }));
}

async function fetchHourlyPattern(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'hour' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    dimensionFilter: JAPAN_ONLY,
  });
  // hour は "00" 〜 "23" の文字列
  // 朝(6-11) / 昼(12-17) / 夜(18-23) / 深夜(0-5) に集約
  const buckets = {
    '🌅 朝 (6-11)': { pv: 0, uu: 0, hours: '06-11' },
    '☀️ 昼 (12-17)': { pv: 0, uu: 0, hours: '12-17' },
    '🌙 夜 (18-23)': { pv: 0, uu: 0, hours: '18-23' },
    '🌌 深夜 (0-5)': { pv: 0, uu: 0, hours: '00-05' },
  };
  for (const r of resp.rows || []) {
    const h = parseInt(r.dimensionValues[0].value);
    const pv = parseInt(r.metricValues[0].value || 0);
    const uu = parseInt(r.metricValues[1].value || 0);
    let key;
    if (h >= 6 && h <= 11) key = '🌅 朝 (6-11)';
    else if (h >= 12 && h <= 17) key = '☀️ 昼 (12-17)';
    else if (h >= 18 && h <= 23) key = '🌙 夜 (18-23)';
    else key = '🌌 深夜 (0-5)';
    buckets[key].pv += pv;
    buckets[key].uu += uu;
  }
  return Object.entries(buckets).map(([label, v]) => ({ label, ...v }));
}

async function fetchNewVsReturning(startDate, endDate) {
  const [resp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'newVsReturning' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'averageSessionDuration' },
    ],
    dimensionFilter: JAPAN_ONLY,
  });
  const result = { new: { pv: 0, uu: 0, avgDuration: 0 }, returning: { pv: 0, uu: 0, avgDuration: 0 } };
  for (const r of resp.rows || []) {
    const key = r.dimensionValues[0].value === 'new' ? 'new' : (r.dimensionValues[0].value === 'returning' ? 'returning' : null);
    if (!key) continue;
    result[key].pv = parseInt(r.metricValues[0].value || 0);
    result[key].uu = parseInt(r.metricValues[1].value || 0);
    result[key].avgDuration = parseFloat(r.metricValues[2].value || 0);
  }
  const totalUu = result.new.uu + result.returning.uu;
  result.returningRate = totalUu > 0 ? result.returning.uu / totalUu : 0;
  return result;
}

// ---------- GSC ----------

const auth = new google.auth.GoogleAuth({
  keyFile: credPath,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});
const searchconsole = google.searchconsole({ version: 'v1', auth });
const siteUrl = process.env.GSC_SITE_URL;

// GSC の Japan セグメント (ISO 3166-1 alpha-3 lowercase = "jpn")
const GSC_JAPAN_FILTER_GROUP = {
  filters: [
    { dimension: 'country', operator: 'equals', expression: 'jpn' },
  ],
};

async function fetchQueries(startDate, endDate, rowLimit = 200) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate, endDate,
      dimensions: ['query'],
      rowLimit,
      dimensionFilterGroups: [GSC_JAPAN_FILTER_GROUP],
    },
  });
  return (res.data.rows || []).map((r) => ({
    query: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position,
  }));
}

async function fetchPageQueries(startDate, endDate, rowLimit = 500) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate, endDate,
      dimensions: ['page', 'query'],
      rowLimit,
      dimensionFilterGroups: [GSC_JAPAN_FILTER_GROUP],
    },
  });
  return (res.data.rows || []).map((r) => ({
    page: r.keys[0],
    query: r.keys[1],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position,
  }));
}

// ---------- Article keywords loader ----------

function loadArticleKeywords() {
  const articles = {};
  if (!existsSync(POSTS_DIR)) return articles;
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.mdx'));
  for (const file of files) {
    const slug = file.replace('.mdx', '');
    const content = readFileSync(join(POSTS_DIR, file), 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];

    const titleMatch = fm.match(/title:\s*["']?(.+?)["']?\s*$/m);
    const featuredMatch = fm.match(/featuredKeyword:\s*["']?(.+?)["']?\s*$/m);
    const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/);
    const tags = tagsMatch ? tagsMatch[1].split(',').map((t) => t.trim().replace(/["']/g, '')) : [];

    const keywords = new Set();
    if (titleMatch) {
      // Extract words from title (Japanese-aware: split on common separators)
      const title = titleMatch[1];
      title.split(/[\s\-—「」『』,、。・/()「]+/).forEach((w) => {
        if (w.length >= 2) keywords.add(w.toLowerCase());
      });
    }
    if (featuredMatch) {
      featuredMatch[1].split(/\s+/).forEach((w) => {
        if (w.length >= 2) keywords.add(w.toLowerCase());
      });
    }
    tags.forEach((t) => keywords.add(t.toLowerCase()));

    articles[`/posts/${slug}/`] = {
      slug,
      title: titleMatch ? titleMatch[1] : slug,
      featured: featuredMatch ? featuredMatch[1] : '',
      tags,
      keywords: Array.from(keywords),
    };
  }
  return articles;
}

// ---------- Analysis ----------

function findImprovementCandidates(queries) {
  // 高 imp × 低 CTR × 順位10位以内 = タイトル改善余地大
  return queries
    .filter((q) => q.impressions >= 100 && q.ctr < 0.02 && q.position <= 10)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);
}

function findUnexpectedQueries(pageQueries, articles) {
  const unexpected = [];
  for (const pq of pageQueries) {
    const article = articles[pq.page];
    if (!article) continue;
    const queryLower = pq.query.toLowerCase();
    const matched = article.keywords.some((kw) => queryLower.includes(kw));
    if (!matched && pq.impressions >= 10) {
      unexpected.push({ ...pq, articleTitle: article.title });
    }
  }
  return unexpected.sort((a, b) => b.impressions - a.impressions).slice(0, 10);
}

function findNewQueries(thisWeek, lastWeek) {
  const lastSet = new Map(lastWeek.map((q) => [q.query, q]));
  const newQ = [];
  for (const q of thisWeek) {
    const last = lastSet.get(q.query);
    if ((!last || last.impressions < 3) && q.impressions >= 10) {
      newQ.push({ ...q, prevImpressions: last ? last.impressions : 0 });
    }
  }
  return newQ.sort((a, b) => b.impressions - a.impressions).slice(0, 10);
}

function findHighBouncePages(pages) {
  return pages
    .filter((p) => p.bounceRate > 0.8 && p.pv >= 10)
    .sort((a, b) => b.pv - a.pv)
    .slice(0, 5);
}

function generateActionableSuggestions(data) {
  const suggestions = [];

  // タイトル改善（記事別）
  for (const c of data.improvementCandidates.slice(0, 3)) {
    const targetCTR = 0.04;
    const projectedClicks = Math.round(c.impressions * targetCTR);
    const currentClicks = c.clicks;
    const lift = projectedClicks - currentClicks;
    suggestions.push({
      priority: '🎯 最優先',
      target: c.query,
      action: `「${c.query}」（imp ${c.impressions}, CTR ${(c.ctr * 100).toFixed(1)}%, 順位 ${c.position.toFixed(1)}）→ タイトルA/Bテスト`,
      impact: `CTR ${(c.ctr * 100).toFixed(1)}% → 4% で +${lift} click/週見込み`,
    });
  }

  // 想定外クエリで新コンテンツ機会
  for (const u of data.unexpectedQueries.slice(0, 2)) {
    if (u.impressions >= 50) {
      suggestions.push({
        priority: '🆕 新コンテンツ機会',
        target: u.query,
        action: `${u.articleTitle} に「${u.query}」セクション追加検討`,
        impact: `imp ${u.impressions} のキーワードで関連流入取り込み`,
      });
    }
  }

  // 新着クエリ
  for (const n of data.newQueries.slice(0, 2)) {
    suggestions.push({
      priority: '📈 新着トレンド',
      target: n.query,
      action: `「${n.query}」が今週急増（${n.prevImpressions} → ${n.impressions} imp）→ 専用記事 or 既存記事補強`,
      impact: '需要の兆し検出',
    });
  }

  // 離脱率高
  for (const h of data.highBouncePages.slice(0, 2)) {
    suggestions.push({
      priority: '⚠️ 離脱対策',
      target: h.path,
      action: `${h.path} 冒頭リライト（離脱率 ${(h.bounceRate * 100).toFixed(0)}%）`,
      impact: `滞在時間延長 → CV機会増`,
    });
  }

  return suggestions;
}

// ---------- Markdown builder ----------

function buildMarkdown(data, weekInfo, period) {
  const md = [];

  md.push(`---`);
  md.push(`slug: weekly-report-${weekInfo.label}`);
  md.push(`date: ${new Date().toISOString().slice(0, 10)}`);
  md.push(`period: ${period.start} - ${period.end}`);
  md.push(`type: weekly-report`);
  md.push(`segment: Japan only (country = "Japan" / "jpn")`);
  md.push(`---`);
  md.push('');
  md.push(`# Week ${weekInfo.label} レポート`);
  md.push('');
  md.push(`期間: **${period.start} 〜 ${period.end}**（前週比較あり）`);
  md.push(`セグメント: **🇯🇵 日本国内アクセスのみ**（GA4 country=Japan / GSC country=jpn）`);
  md.push('');

  // Summary
  md.push(`## 📊 サマリー`);
  md.push('');
  md.push(`| 指標 | 今週 | 前週 | 増減 |`);
  md.push(`|---|---|---|---|`);
  md.push(`| 総PV | ${data.thisWeek.summary.pv.toLocaleString()} | ${data.lastWeek.summary.pv.toLocaleString()} | ${delta(data.thisWeek.summary.pv, data.lastWeek.summary.pv)} |`);
  md.push(`| ユニークユーザー | ${data.thisWeek.summary.uu.toLocaleString()} | ${data.lastWeek.summary.uu.toLocaleString()} | ${delta(data.thisWeek.summary.uu, data.lastWeek.summary.uu)} |`);
  md.push(`| 平均滞在時間 | ${data.thisWeek.summary.avgDuration.toFixed(0)}秒 | ${data.lastWeek.summary.avgDuration.toFixed(0)}秒 | ${delta(data.thisWeek.summary.avgDuration, data.lastWeek.summary.avgDuration)} |`);
  md.push(`| 離脱率 | ${(data.thisWeek.summary.bounceRate * 100).toFixed(1)}% | ${(data.lastWeek.summary.bounceRate * 100).toFixed(1)}% | ${deltaPP(data.thisWeek.summary.bounceRate, data.lastWeek.summary.bounceRate)} |`);
  const totalClicksThis = data.thisWeek.outboundClicks.reduce((s, p) => s + p.clicks, 0);
  const totalClicksLast = data.lastWeek.outboundClicks.reduce((s, p) => s + p.clicks, 0);
  md.push(`| outbound_click 合計 | ${totalClicksThis} | ${totalClicksLast} | ${delta(totalClicksThis, totalClicksLast)} |`);
  md.push(`| outbound_click率 | ${pct(totalClicksThis, data.thisWeek.summary.pv)} | ${pct(totalClicksLast, data.lastWeek.summary.pv)} | - |`);
  md.push('');

  // TOP pages
  md.push(`## 🏆 TOP10 ページ（PV順）`);
  md.push('');
  md.push(`| 順位 | パス | PV | UU | 平均滞在 | 離脱率 |`);
  md.push(`|---|---|---|---|---|---|`);
  data.thisWeek.pages.slice(0, 10).forEach((p, i) => {
    md.push(`| ${i + 1} | ${p.path} | ${p.pv} | ${p.uu} | ${p.avgDuration.toFixed(0)}s | ${(p.bounceRate * 100).toFixed(0)}% |`);
  });
  md.push('');

  // Outbound clicks per page
  md.push(`## 💰 ページ別 outbound_click（CV貢献）`);
  md.push('');
  if (data.thisWeek.outboundClicks.length === 0) {
    md.push(`まだ outbound_click イベントの記録なし。`);
  } else {
    md.push(`| 順位 | パス | クリック数 |`);
    md.push(`|---|---|---|`);
    data.thisWeek.outboundClicks.slice(0, 10).forEach((p, i) => {
      md.push(`| ${i + 1} | ${p.path} | ${p.clicks} |`);
    });
  }
  md.push('');

  // === 戦略系メトリクス（2026-05-16 追加：層2 温度感）===

  // 再訪率（最重要、サイト愛着度の核）
  md.push(`## 🔁 再訪率（New vs Returning）`);
  md.push('');
  md.push(`サイト愛着度の核指標。\`_docs/07_KPI_PHILOSOPHY.md\` 層2 温度感に該当。`);
  md.push('');
  md.push(`| 種別 | UU | PV | 平均滞在 |`);
  md.push(`|---|---|---|---|`);
  md.push(`| 🆕 新規 | ${data.thisWeek.newVsReturning.new.uu} | ${data.thisWeek.newVsReturning.new.pv} | ${data.thisWeek.newVsReturning.new.avgDuration.toFixed(0)}s |`);
  md.push(`| 🔁 リピーター | ${data.thisWeek.newVsReturning.returning.uu} | ${data.thisWeek.newVsReturning.returning.pv} | ${data.thisWeek.newVsReturning.returning.avgDuration.toFixed(0)}s |`);
  md.push('');
  md.push(`**再訪率: ${(data.thisWeek.newVsReturning.returningRate * 100).toFixed(1)}%**（前週 ${(data.lastWeek.newVsReturning.returningRate * 100).toFixed(1)}% → ${deltaPP(data.thisWeek.newVsReturning.returningRate, data.lastWeek.newVsReturning.returningRate)}）`);
  md.push('');

  // 流入元内訳
  md.push(`## 🚪 流入元内訳`);
  md.push('');
  md.push(`サイトの「発見されかた」。Organic Search 比率が高い = SEO 健全、Direct 比率が高い = ブックマーク・口コミ層あり。`);
  md.push('');
  if (data.thisWeek.trafficSources.length === 0) {
    md.push(`データなし（蓄積中）。`);
  } else {
    md.push(`| チャネル | PV | UU | セッション | PV比率 |`);
    md.push(`|---|---|---|---|---|`);
    const totalPv = data.thisWeek.trafficSources.reduce((s, c) => s + c.pv, 0);
    data.thisWeek.trafficSources.forEach((c) => {
      const ratio = totalPv > 0 ? ((c.pv / totalPv) * 100).toFixed(1) + '%' : '-';
      md.push(`| ${c.channel} | ${c.pv} | ${c.uu} | ${c.sessions} | ${ratio} |`);
    });
  }
  md.push('');

  // デバイス別
  md.push(`## 📱 デバイス別`);
  md.push('');
  md.push(`読者の利用シーン推定。Mobile 比率と平均滞在時間の関係性に注目。`);
  md.push('');
  if (data.thisWeek.devices.length === 0) {
    md.push(`データなし（蓄積中）。`);
  } else {
    md.push(`| デバイス | PV | UU | 平均滞在 | 離脱率 |`);
    md.push(`|---|---|---|---|---|`);
    data.thisWeek.devices.forEach((d) => {
      md.push(`| ${d.device} | ${d.pv} | ${d.uu} | ${d.avgDuration.toFixed(0)}s | ${(d.bounceRate * 100).toFixed(0)}% |`);
    });
  }
  md.push('');

  // 時間帯別アクセスパターン
  md.push(`## 🕐 時間帯別アクセスパターン`);
  md.push('');
  md.push(`読者の生活リズム。サイト世界観と整合してるか確認用。`);
  md.push('');
  if (data.thisWeek.hourly.length === 0 || data.thisWeek.hourly.every((h) => h.pv === 0)) {
    md.push(`データなし（蓄積中）。`);
  } else {
    const totalPv = data.thisWeek.hourly.reduce((s, h) => s + h.pv, 0);
    md.push(`| 時間帯 | PV | UU | PV比率 |`);
    md.push(`|---|---|---|---|`);
    data.thisWeek.hourly.forEach((h) => {
      const ratio = totalPv > 0 ? ((h.pv / totalPv) * 100).toFixed(1) + '%' : '-';
      md.push(`| ${h.label} | ${h.pv} | ${h.uu} | ${ratio} |`);
    });
  }
  md.push('');

  // === 既存セクション（GSC 系）===

  // Improvement candidates
  md.push(`## 📉 改善候補TOP5（高imp × 低CTR × 順位10位以内）`);
  md.push('');
  if (data.improvementCandidates.length === 0) {
    md.push(`今週は該当クエリなし（imp >= 100 かつ CTR < 2% かつ 順位 <= 10）。`);
  } else {
    md.push(`| クエリ | imp | clicks | CTR | 順位 | 提案 |`);
    md.push(`|---|---|---|---|---|---|`);
    data.improvementCandidates.forEach((q) => {
      md.push(`| "${q.query}" | ${q.impressions} | ${q.clicks} | ${(q.ctr * 100).toFixed(1)}% | ${q.position.toFixed(1)} | タイトルA/Bテスト推奨 |`);
    });
  }
  md.push('');

  // Unexpected queries
  md.push(`## 🔍 想定外クエリTOP10（記事キーワード外で流入）`);
  md.push('');
  if (data.unexpectedQueries.length === 0) {
    md.push(`今週は想定外クエリなし。`);
  } else {
    md.push(`| クエリ | imp | clicks | 流入記事 |`);
    md.push(`|---|---|---|---|`);
    data.unexpectedQueries.forEach((q) => {
      md.push(`| "${q.query}" | ${q.impressions} | ${q.clicks} | ${q.articleTitle.slice(0, 40)} |`);
    });
  }
  md.push('');

  // New queries
  md.push(`## 🆕 新着クエリTOP10（先週比で急増）`);
  md.push('');
  if (data.newQueries.length === 0) {
    md.push(`今週は新着クエリなし。`);
  } else {
    md.push(`| クエリ | 今週imp | 前週imp | clicks |`);
    md.push(`|---|---|---|---|`);
    data.newQueries.forEach((q) => {
      md.push(`| "${q.query}" | ${q.impressions} | ${q.prevImpressions} | ${q.clicks} |`);
    });
  }
  md.push('');

  // High bounce
  md.push(`## ⚠️ 離脱率ワースト5`);
  md.push('');
  if (data.highBouncePages.length === 0) {
    md.push(`離脱率80%超のページなし（PV >= 10 のみ対象）。`);
  } else {
    md.push(`| パス | 離脱率 | PV | 平均滞在 |`);
    md.push(`|---|---|---|---|`);
    data.highBouncePages.forEach((p) => {
      md.push(`| ${p.path} | ${(p.bounceRate * 100).toFixed(0)}% | ${p.pv} | ${p.avgDuration.toFixed(0)}s |`);
    });
  }
  md.push('');

  // Actionable suggestions
  md.push(`## 💡 アクション可能な改善提案`);
  md.push('');
  if (data.suggestions.length === 0) {
    md.push(`今週は自動提案なし。`);
  } else {
    data.suggestions.forEach((s) => {
      md.push(`### ${s.priority}: ${s.target}`);
      md.push(`- **アクション**: ${s.action}`);
      md.push(`- **想定効果**: ${s.impact}`);
      md.push('');
    });
  }
  md.push('');

  md.push(`---`);
  md.push(`*自動生成: ${new Date().toISOString()} by generate-weekly-report.js*`);
  md.push('');
  return md.join('\n');
}

// ---------- Main ----------

(async () => {
  log.head('📊 週次レポート生成開始');

  const today = new Date();
  const weekInfo = getISOWeek(today);
  const period = { start: dateNDaysAgo(7), end: dateNDaysAgo(1) };
  const lastPeriod = { start: dateNDaysAgo(14), end: dateNDaysAgo(8) };

  log.info(`Week: ${weekInfo.label}, Period: ${period.start} - ${period.end}`);

  // Article keywords (local)
  log.info('記事キーワード読み込み...');
  const articles = loadArticleKeywords();
  log.ok(`記事 ${Object.keys(articles).length} 本読み込み`);

  // GA4
  log.head('GA4 取得');
  const data = { thisWeek: {}, lastWeek: {} };
  try {
    data.thisWeek.summary = await fetchSummaryMetrics(period.start, period.end);
    data.lastWeek.summary = await fetchSummaryMetrics(lastPeriod.start, lastPeriod.end);
    log.ok(`今週 PV ${data.thisWeek.summary.pv} / 前週 PV ${data.lastWeek.summary.pv}`);

    data.thisWeek.pages = await fetchPageBreakdown(period.start, period.end);
    log.ok(`ページ別データ ${data.thisWeek.pages.length} 件`);

    data.thisWeek.outboundClicks = await fetchOutboundClicks(period.start, period.end);
    data.lastWeek.outboundClicks = await fetchOutboundClicks(lastPeriod.start, lastPeriod.end);
    log.ok(`outbound_click 今週 ${data.thisWeek.outboundClicks.length} ページ / 前週 ${data.lastWeek.outboundClicks.length} ページ`);

    // 戦略系メトリクス（2026-05-16 追加：層2 温度感）
    data.thisWeek.trafficSources = await fetchTrafficSources(period.start, period.end);
    data.lastWeek.trafficSources = await fetchTrafficSources(lastPeriod.start, lastPeriod.end);
    log.ok(`流入元 今週 ${data.thisWeek.trafficSources.length} チャネル`);

    data.thisWeek.devices = await fetchDeviceBreakdown(period.start, period.end);
    log.ok(`デバイス別 ${data.thisWeek.devices.length} 種`);

    data.thisWeek.hourly = await fetchHourlyPattern(period.start, period.end);
    log.ok(`時間帯別 4 バケット集計`);

    data.thisWeek.newVsReturning = await fetchNewVsReturning(period.start, period.end);
    data.lastWeek.newVsReturning = await fetchNewVsReturning(lastPeriod.start, lastPeriod.end);
    log.ok(`再訪率 今週 ${(data.thisWeek.newVsReturning.returningRate * 100).toFixed(1)}% / 前週 ${(data.lastWeek.newVsReturning.returningRate * 100).toFixed(1)}%`);
  } catch (e) {
    log.err(`GA4 取得失敗: ${e.message}`);
    log.warn('部分データで継続');
    data.thisWeek.summary = data.thisWeek.summary || { pv: 0, uu: 0, avgDuration: 0, bounceRate: 0 };
    data.lastWeek.summary = data.lastWeek.summary || { pv: 0, uu: 0, avgDuration: 0, bounceRate: 0 };
    data.thisWeek.pages = data.thisWeek.pages || [];
    data.thisWeek.outboundClicks = data.thisWeek.outboundClicks || [];
    data.lastWeek.outboundClicks = data.lastWeek.outboundClicks || [];
    data.thisWeek.trafficSources = data.thisWeek.trafficSources || [];
    data.lastWeek.trafficSources = data.lastWeek.trafficSources || [];
    data.thisWeek.devices = data.thisWeek.devices || [];
    data.thisWeek.hourly = data.thisWeek.hourly || [];
    data.thisWeek.newVsReturning = data.thisWeek.newVsReturning || { new: { pv: 0, uu: 0 }, returning: { pv: 0, uu: 0 }, returningRate: 0 };
    data.lastWeek.newVsReturning = data.lastWeek.newVsReturning || { new: { pv: 0, uu: 0 }, returning: { pv: 0, uu: 0 }, returningRate: 0 };
  }

  // GSC (48-72h delay so use earlier dates)
  log.head('GSC 取得');
  const gscPeriod = { start: dateNDaysAgo(10), end: dateNDaysAgo(3) };
  const gscLastPeriod = { start: dateNDaysAgo(17), end: dateNDaysAgo(11) };
  try {
    data.thisWeek.queries = await fetchQueries(gscPeriod.start, gscPeriod.end);
    data.lastWeek.queries = await fetchQueries(gscLastPeriod.start, gscLastPeriod.end);
    data.thisWeek.pageQueries = await fetchPageQueries(gscPeriod.start, gscPeriod.end);
    log.ok(`今週クエリ ${data.thisWeek.queries.length} / ページクエリ ${data.thisWeek.pageQueries.length}`);
  } catch (e) {
    log.err(`GSC 取得失敗: ${e.message}`);
    data.thisWeek.queries = [];
    data.lastWeek.queries = [];
    data.thisWeek.pageQueries = [];
  }

  // Analysis
  log.head('分析');
  data.improvementCandidates = findImprovementCandidates(data.thisWeek.queries);
  data.unexpectedQueries = findUnexpectedQueries(data.thisWeek.pageQueries, articles);
  data.newQueries = findNewQueries(data.thisWeek.queries, data.lastWeek.queries);
  data.highBouncePages = findHighBouncePages(data.thisWeek.pages);
  data.suggestions = generateActionableSuggestions(data);
  log.ok(`改善候補 ${data.improvementCandidates.length} / 想定外 ${data.unexpectedQueries.length} / 新着 ${data.newQueries.length} / 離脱高 ${data.highBouncePages.length} / 提案 ${data.suggestions.length}`);

  // Output
  log.head('出力');
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    log.ok(`Created: ${REPORTS_DIR}`);
  }
  const md = buildMarkdown(data, weekInfo, period);
  const outPath = join(REPORTS_DIR, `${weekInfo.label}.md`);
  writeFileSync(outPath, md, 'utf-8');
  log.ok(`保存: ${outPath}`);

  // Summary to console (for scheduled task log)
  log.head('✨ 今週のハイライト');
  console.log(`  PV: ${data.thisWeek.summary.pv.toLocaleString()} (${delta(data.thisWeek.summary.pv, data.lastWeek.summary.pv)})`);
  const totalClicksThis = data.thisWeek.outboundClicks.reduce((s, p) => s + p.clicks, 0);
  console.log(`  outbound_click: ${totalClicksThis}`);
  console.log(`  改善提案: ${data.suggestions.length} 件`);
  if (data.suggestions.length > 0) {
    console.log(`    最優先: ${data.suggestions[0].action.slice(0, 80)}`);
  }
  console.log(`  詳細: ${outPath}`);
})();
