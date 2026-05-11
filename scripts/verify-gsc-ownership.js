#!/usr/bin/env node
/**
 * verify-gsc-ownership.js
 *
 * サービスアカウント自身を deskscape サイトの「所有者」として登録するスクリプト。
 * GSC UI でユーザー追加が弾かれる時の代替手段。
 *
 * フロー:
 *   1. node scripts/verify-gsc-ownership.js request  → 検証ファイル名と内容を表示
 *   2. ユーザーが public/ に検証ファイルを配置 → push → デプロイ完了待ち
 *   3. node scripts/verify-gsc-ownership.js verify   → 所有者として登録
 *
 * 使い方:
 *   npm run gsc-verify -- request
 *   npm run gsc-verify -- verify
 */

import { google } from 'googleapis';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = resolve(__dirname, '../.verification-token.json');

const COLOR = {
  reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m',
  red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const log = {
  ok: (m) => console.log(`${COLOR.green}✅${COLOR.reset} ${m}`),
  warn: (m) => console.log(`${COLOR.yellow}⚠️ ${COLOR.reset} ${m}`),
  err: (m) => console.log(`${COLOR.red}❌${COLOR.reset} ${m}`),
  info: (m) => console.log(`${COLOR.cyan}ℹ${COLOR.reset}  ${m}`),
  head: (m) => console.log(`\n${COLOR.bold}${m}${COLOR.reset}`),
  dim: (m) => console.log(`${COLOR.dim}${m}${COLOR.reset}`),
};

const cmd = process.argv[2];
if (!['request', 'verify'].includes(cmd)) {
  log.err('使い方: node scripts/verify-gsc-ownership.js [request|verify]');
  process.exit(1);
}

const credPath = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (!existsSync(credPath)) {
  log.err(`サービスアカウント JSON が見つかりません: ${credPath}`);
  process.exit(1);
}

const siteUrl = process.env.GSC_SITE_URL;
if (!siteUrl) {
  log.err('環境変数 GSC_SITE_URL が未設定');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile: credPath,
  scopes: [
    'https://www.googleapis.com/auth/siteverification',
    'https://www.googleapis.com/auth/webmasters',
  ],
});
const siteVerification = google.siteVerification({ version: 'v1', auth });
const webmasters = google.webmasters({ version: 'v3', auth });

if (cmd === 'request') {
  // ---------- 1. 検証トークンをリクエスト ----------
  log.head('🔑 検証トークンをリクエスト中…');

  try {
    const res = await siteVerification.webResource.getToken({
      requestBody: {
        verificationMethod: 'FILE',
        site: {
          type: 'SITE',
          identifier: siteUrl + (siteUrl.endsWith('/') ? '' : '/'),
        },
      },
    });

    const token = res.data.token; // 例: "google-site-verification: googleXXXX.html"
    const fileName = token; // FILE method では token が直接ファイル名になる

    log.ok('検証トークン取得成功');
    log.info(`ファイル名: ${fileName}`);

    // public/ に書き込む
    const publicPath = resolve(__dirname, '../public', fileName);
    const fileContent = `google-site-verification: ${fileName}\n`;
    writeFileSync(publicPath, fileContent, 'utf-8');
    log.ok(`検証ファイルを作成: ${publicPath}`);

    // 後続用にトークンをキャッシュ
    writeFileSync(
      TOKEN_CACHE_PATH,
      JSON.stringify({ token, fileName, siteUrl, timestamp: new Date().toISOString() }, null, 2)
    );

    log.head('📋 次のアクション');
    log.info(`1. ファイルが ${COLOR.bold}public/${fileName}${COLOR.reset} に作成されました`);
    log.info(`2. GitHub にコミット & プッシュしてください`);
    log.info(`3. Cloudflare Pages のビルドが完了するまで待つ（1〜3分）`);
    log.info(`4. ブラウザで ${siteUrl}/${fileName} にアクセスして 200 が返ることを確認`);
    log.info(`5. その後: ${COLOR.bold}npm run gsc-verify -- verify${COLOR.reset}`);
  } catch (e) {
    log.err(`トークン取得エラー: ${e.message}`);
    if (String(e.message).includes('has not been used') || String(e.message).includes('siteVerification')) {
      log.warn('→ Site Verification API がGCPで未有効化の可能性');
      log.dim(`   有効化URL: https://console.cloud.google.com/apis/library/siteverification.googleapis.com?project=deskscape-analytics`);
    }
  }
} else {
  // ---------- 2. 所有者として認証 ----------
  log.head('🔐 所有者として認証中…');

  if (!existsSync(TOKEN_CACHE_PATH)) {
    log.err('トークンキャッシュが見つかりません。先に `request` を実行してください');
    process.exit(1);
  }

  const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf-8'));
  log.info(`キャッシュされた検証情報: ${cached.fileName}`);

  // ファイルが本番でアクセス可能か事前チェック
  log.info(`本番アクセス確認中: ${siteUrl}/${cached.fileName}`);
  try {
    const fetchRes = await fetch(`${siteUrl}/${cached.fileName}`);
    if (!fetchRes.ok) {
      log.err(`本番に検証ファイルが見つかりません (HTTP ${fetchRes.status})`);
      log.warn('→ push 後 Cloudflare のビルド完了を待ってからリトライしてください');
      process.exit(1);
    }
    log.ok('本番に検証ファイルが配置されてます');
  } catch (e) {
    log.err(`本番チェックエラー: ${e.message}`);
    process.exit(1);
  }

  try {
    const res = await siteVerification.webResource.insert({
      verificationMethod: 'FILE',
      requestBody: {
        site: {
          type: 'SITE',
          identifier: siteUrl + (siteUrl.endsWith('/') ? '' : '/'),
        },
      },
    });

    log.ok('所有者として登録成功！');
    log.dim(`  resource id: ${res.data.id}`);
    log.dim(`  owners: ${(res.data.owners || []).join(', ')}`);

    // ---------- 3. Search Console のサイトリストにも登録 ----------
    log.head('🌐 Search Console プロパティに登録中…');
    const siteUrlWithSlash = siteUrl + (siteUrl.endsWith('/') ? '' : '/');

    try {
      await webmasters.sites.add({ siteUrl: siteUrlWithSlash });
      log.ok(`Search Console プロパティ追加: ${siteUrlWithSlash}`);
    } catch (e) {
      if (String(e.message).includes('already')) {
        log.info('既に Search Console に登録済みでした');
      } else {
        log.warn(`sites.add: ${e.message}`);
        log.dim('  （Site Verification が成功してれば searchanalytics.query は通る可能性あり）');
      }
    }

    // ---------- 4. 確認 ----------
    log.head('🔎 アクセス可能なサイト一覧（サービスアカウント視点）');
    try {
      const sites = await webmasters.sites.list({});
      const list = sites.data.siteEntry || [];
      if (list.length === 0) {
        log.warn('  サイト一覧が空です');
      } else {
        for (const s of list) {
          log.dim(`  ${s.siteUrl} — ${s.permissionLevel}`);
        }
      }
    } catch (e) {
      log.warn(`sites.list: ${e.message}`);
    }

    log.head('🎉 完了');
    log.info('GSC API でこのサイトのデータが取得可能になりました');
    log.info('動作確認: npm run check-pipeline');
  } catch (e) {
    log.err(`認証エラー: ${e.message}`);
    if (String(e.message).includes('Token not found')) {
      log.warn('→ 検証ファイルがアクセスできない可能性。本番URLで直接確認してください');
    }
  }
}
