#!/usr/bin/env node
/**
 * submit-sitemap.js
 *
 * GSC Search Console API でサイトマップを送信する。
 * 前提: scripts/verify-gsc-ownership.js verify を実行済みで、
 *       SA が siteOwner として登録されていること。
 *
 * 使い方:
 *   node --env-file=.env scripts/submit-sitemap.js
 */

import { google } from 'googleapis';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m',
  red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const log = {
  ok: (m) => console.log(`${C.green}OK${C.reset} ${m}`),
  warn: (m) => console.log(`${C.yellow}WARN${C.reset} ${m}`),
  err: (m) => console.log(`${C.red}ERR${C.reset} ${m}`),
  info: (m) => console.log(`${C.cyan}info${C.reset}  ${m}`),
  head: (m) => console.log(`\n${C.bold}${m}${C.reset}`),
};

const credPath = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || '');
if (!credPath || !existsSync(credPath)) {
  log.err(`SA JSON not found: ${credPath}`);
  process.exit(1);
}

const siteUrl = process.env.GSC_SITE_URL;
if (!siteUrl) {
  log.err('GSC_SITE_URL is not set');
  process.exit(1);
}

// URL-prefix property のサイト URL は末尾スラッシュ必須
const siteUrlNorm = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;

// 送信するサイトマップ URL
const sitemapUrl = `${siteUrlNorm}sitemap-index.xml`;

log.head('Submit sitemap to GSC');
log.info(`site:    ${siteUrlNorm}`);
log.info(`sitemap: ${sitemapUrl}`);

const auth = new google.auth.GoogleAuth({
  keyFile: credPath,
  scopes: ['https://www.googleapis.com/auth/webmasters'],
});

const searchconsole = google.searchconsole({ version: 'v1', auth });

try {
  await searchconsole.sitemaps.submit({
    siteUrl: siteUrlNorm,
    feedpath: sitemapUrl,
  });
  log.ok('sitemap submitted');
} catch (e) {
  log.err(`submit failed: ${e?.message || e}`);
  process.exit(1);
}

// 状態確認
try {
  const res = await searchconsole.sitemaps.get({
    siteUrl: siteUrlNorm,
    feedpath: sitemapUrl,
  });
  log.head('sitemap status');
  const s = res.data;
  console.log(`  path:        ${s.path}`);
  console.log(`  lastSubmitted: ${s.lastSubmitted}`);
  console.log(`  isPending:   ${s.isPending}`);
  console.log(`  isSitemapsIndex: ${s.isSitemapsIndex}`);
  console.log(`  type:        ${s.type}`);
  if (s.contents) {
    for (const c of s.contents) {
      console.log(`  contents:    type=${c.type} submitted=${c.submitted} indexed=${c.indexed}`);
    }
  }
} catch (e) {
  log.warn(`status fetch failed: ${e?.message || e}`);
}

log.head('Done');
