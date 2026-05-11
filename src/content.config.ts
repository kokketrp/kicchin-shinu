import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 📊 比較レポート（スペック中心のガチ比較）
const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.string().optional(),
    featuredKeyword: z.string().optional(),
    tags: z.array(z.string()).default([]),
    heroImage: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

// 📖 本編（連載エッセイ）
const essays = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/essays' }),
  schema: z.object({
    episode: z.number().int().positive(),    // 第N話
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    excerpt: z.string().optional(),          // タイトル断片（カードに大きく表示）
    mark: z.string().min(1).max(2).optional(),  // 検印一文字（例：読/水/麦/時/円/独）
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    eyecatch: z.string().optional(),         // emoji
    relatedPosts: z.array(z.string()).default([]),  // 関連する比較記事のslug
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

// ☕ 閑話（脱線・小品）
const interludes = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/interludes' }),
  schema: z.object({
    number: z.number().int().positive(),     // 閑話 #N
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    mark: z.string().min(1).max(2).optional().default('閑'),  // デフォルト「閑」
    pubDate: z.coerce.date(),
    eyecatch: z.string().optional(),
    relatedEssay: z.number().int().positive().optional(),  // どの本編の合間か
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

// 🌙 番外（別視点・特別企画）
const extras = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/extras' }),
  schema: z.object({
    number: z.number().int().positive(),     // 番外編 #N
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    mark: z.string().min(1).max(2).optional(),  // 季節印 or 視点印（夏/冬/夫/独 等）
    pubDate: z.coerce.date(),
    eyecatch: z.string().optional(),
    perspective: z.string().optional(),       // 「夫視点」「子供視点」「夏休み特別号」等
    season: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

export const collections = { posts, essays, interludes, extras, pages };
