#!/usr/bin/env node
/**
 * publish-article.js (Hibi 版)
 *
 * Hibi は posts / essays / interludes / extras の 4 タイプがあるため、
 * 第 1 引数で type を指定する：
 *
 * 使い方:
 *   node scripts/publish-article.js <type> <slug> [<commit-message>]
 *   npm run publish-article -- <type> <slug> [<commit-message>]
 *
 *   <type>: posts / essays / interludes / extras
 *
 * 動作:
 * 1. frontmatter の draft: true → false に変更（既に false なら skip）
 * 2. _topic-pool.md の該当行を ⏳/🟡 → 🟢 に変更（best-effort）
 * 3. git add / commit / push
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TOPIC_POOL = join(ROOT, 'editorial', '_topic-pool.md');

const VALID_TYPES = ['posts', 'essays', 'interludes', 'extras'];
const type = process.argv[2];
const slug = process.argv[3];
const commitMessage = process.argv[4] || `publish: ${type}/${slug}`;

if (!type || !slug) {
  console.error('Usage: node scripts/publish-article.js <type> <slug> [<commit-message>]');
  console.error(`  <type>: ${VALID_TYPES.join(' / ')}`);
  process.exit(1);
}

if (!VALID_TYPES.includes(type)) {
  console.error(`❌ Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

const TYPE_DIR = join(ROOT, 'src', 'content', type);

// === Step 1: frontmatter draft: true → false ===
const articlePath = join(TYPE_DIR, `${slug}.mdx`);
if (!existsSync(articlePath)) {
  console.error(`❌ Article not found: ${articlePath}`);
  process.exit(1);
}

let content = readFileSync(articlePath, 'utf-8');
const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  console.error('❌ No frontmatter found');
  process.exit(1);
}

const newFm = fmMatch[1].replace(/draft:\s*true/, 'draft: false');
if (newFm === fmMatch[1]) {
  console.log('ℹ  draft already false or no draft field, skipping frontmatter edit');
} else {
  content = content.replace(fmMatch[0], `---\n${newFm}\n---`);
  writeFileSync(articlePath, content, 'utf-8');
  console.log('✅ frontmatter draft: true → false');
}

// === Step 2: _topic-pool.md update (best-effort) ===
let topicPoolUpdated = false;
if (existsSync(TOPIC_POOL)) {
  let pool = readFileSync(TOPIC_POOL, 'utf-8');
  const slugEscaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slugRegex = new RegExp(`^(.*${slugEscaped}.*)$`, 'gm');
  const lines = pool.split('\n').map((line) => {
    if (slugRegex.test(line) && (line.includes('⏳') || line.includes('🟡'))) {
      topicPoolUpdated = true;
      return line.replace(/⏳|🟡/, '🟢');
    }
    return line;
  });
  if (topicPoolUpdated) {
    writeFileSync(TOPIC_POOL, lines.join('\n'), 'utf-8');
    console.log('✅ _topic-pool.md updated (⏳/🟡 → 🟢)');
  } else {
    console.log('ℹ  _topic-pool.md: no matching ⏳/🟡 line for this slug, skipping');
  }
}

// === Step 3: git add / commit / push ===
try {
  console.log('\n🔧 Git operations...');
  const filesToAdd = [`src/content/${type}/${slug}.mdx`];
  if (topicPoolUpdated) {
    filesToAdd.push('editorial/_topic-pool.md');
  }
  execSync(`git add ${filesToAdd.map((f) => JSON.stringify(f)).join(' ')}`, { cwd: ROOT, stdio: 'inherit' });
  execSync(`git commit -m ${JSON.stringify(commitMessage)}`, { cwd: ROOT, stdio: 'inherit' });
  execSync('git push', { cwd: ROOT, stdio: 'inherit' });
  console.log('\n✅ Published successfully!');
} catch (e) {
  console.error(`\n❌ Git operation failed: ${e.message}`);
  process.exit(1);
}
