#!/usr/bin/env node
/**
 * check-data-pipeline.js
 *
 * GA4 Data API + Search Console API の動作確認スクリプト。
 * サービスアカウント認証で両APIを叩き、直近7日のデータが取れるか検証する。
 *
 * 使い方:
 *   npm run check-pipeline
 *
 * 必要な環境変数 (.env):
 *   GOOGLE_APPLICATION_CREDENTIALS=./secrets/ga4-service-account.json
 *   GA4_PROPERTY_ID=536641008
 *   GSC_SITE_URL=https://deskscape.pages.dev
 *
 * 必要なパッケージ:
 *   @google-analytics/data
 *   googleapis
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { google } from 'googleapis';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const log = {
  ok: (msg) => console.log(`${COLOR.green}✅${COLOR.reset} ${msg}`),
  warn: (msg) => console.log(`${COLOR.yellow}⚠️ ${COLOR.reset} ${msg}`),
  err: (msg) => console.log(`${COLOR.red}❌${COLOR.reset} ${msg}`),
  info: (msg) => console.log(`${COLOR.cyan}ℹ${COLOR.reset}  ${msg}`),
  head: (msg) => console.log(`\n${COLOR.bold}${msg}${COLOR.reset}`),
  dim: (msg) => console.log(`${COLOR.dim}${msg}${COLOR.reset}`),
};

const REQUIRED_ENVS = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GA4_PROPERTY_ID',
  'GSC_SITE_URL',
];

// ---------- 0. 前提チェック ----------
log.head('🔧 環境チェック');

let envOk = true;
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    log.err(`環境変数 ${k} が未設定`);
    envOk = false;
  } else {
    log.ok(`${k} = ${k.includes('CREDENTIALS') ? process.env[k] : process.env[k]}`);
  }
}
if (!envOk) {
  log.err('.env を確認してください');
  process.exit(1);
}

const credPath = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (!existsSync(credPath)) {
  log.err(`サービスアカウント JSON が見つからない: ${credPath}`);
  process.exit(1);
}
log.ok(`サービスアカウント JSON 存在: ${credPath}`);

let creds;
try {
  creds = JSON.parse(readFileSync(credPath, 'utf-8'));
  log.ok(`サービスアカウント: ${creds.client_email}`);
} catch (e) {
  log.err(`JSON パース失敗: ${e.message}`);
  process.exit(1);
}

// ---------- 1. GA4 Data API ----------
log.head('📊 GA4 Data API テスト');

const ga4Client = new BetaAnalyticsDataClient({ keyFilename: credPath });
const propertyId = process.env.GA4_PROPERTY_ID;

try {
  const [response] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'bounceRate' },
    ],
    limit: 10,
  });

  log.ok(`GA4 接続成功（プロパティID: ${propertyId}）`);
  log.info(`直近7日 TOP10 ページ:`);

  if (!response.rows || response.rows.length === 0) {
    log.warn('  まだデータがありません（GA4 反映は24時間以内）');
  } else {
    for (const row of response.rows) {
      const path = row.dimensionValues[0].value;
      const pv = row.metricValues[0].value;
      const users = row.metricValues[1].value;
      const bounce = parseFloat(row.metricValues[2].value || 0).toFixed(3);
      log.dim(`  ${pv.padStart(4)} PV / ${users.padStart(3)}人 / 離脱${bounce} — ${path}`);
    }
  }

  // outbound_click イベントも確認
  log.info(`outbound_click イベントカウント:`);
  const [evResp] = await ga4Client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { value: 'outbound_click' },
      },
    },
  });
  if (!evResp.rows || evResp.rows.length === 0) {
    log.warn('  outbound_click イベントはまだ記録されてません');
  } else {
    const cnt = evResp.rows[0].metricValues[0].value;
    log.ok(`  outbound_click 合計: ${cnt} 回（直近7日）`);
  }
} catch (e) {
  log.err(`GA4 API エラー: ${e.message}`);
  if (String(e.message).includes('PERMISSION_DENIED')) {
    log.warn('→ GA4管理画面で「プロパティのアクセス管理」にこのサービスアカウントを追加してください');
    log.dim(`   メアド: ${creds.client_email}`);
    log.dim(`   役割: 閲覧者`);
  }
}

// ---------- 2. Search Console API ----------
log.head('🔍 Search Console API テスト');

const auth = new google.auth.GoogleAuth({
  keyFile: credPath,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

const searchconsole = google.searchconsole({ version: 'v1', auth });
const siteUrl = process.env.GSC_SITE_URL;

try {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: dateNDaysAgo(7),
      endDate: dateNDaysAgo(0),
      dimensions: ['query'],
      rowLimit: 10,
    },
  });

  log.ok(`GSC 接続成功（サイト: ${siteUrl}）`);
  log.info(`直近7日 TOP10 検索クエリ:`);

  const rows = res.data.rows || [];
  if (rows.length === 0) {
    log.warn('  まだ検索流入データがありません（インデックス＋検索発生まで時間がかかる）');
  } else {
    for (const row of rows) {
      const q = row.keys[0];
      const clicks = String(row.clicks);
      const impr = String(row.impressions);
      const ctr = (row.ctr * 100).toFixed(1);
      const pos = row.position.toFixed(1);
      log.dim(`  imp ${impr.padStart(4)} / clk ${clicks.padStart(2)} / CTR ${ctr.padStart(4)}% / 順位 ${pos.padStart(4)} — ${q}`);
    }
  }
} catch (e) {
  log.err(`GSC API エラー: ${e.message}`);
  if (String(e.message).includes('does not have sufficient permission') || String(e.message).includes('User does not have')) {
    log.warn('→ Search Console「設定」→「ユーザーと権限」にこのサービスアカウントを追加してください');
    log.dim(`   メアド: ${creds.client_email}`);
    log.dim(`   権限: 制限付き`);
  }
}

log.head('✨ 完了');

// ---------- helper ----------
function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
