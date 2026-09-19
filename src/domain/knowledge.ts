import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../util/frontmatter.js";
import { sanitizeId } from "../util/ids.js";
import { scoreTerms, snippetFor, tokenize } from "./search.js";
import type { KnowledgeArticle } from "./types.js";

export const DEFAULT_KNOWLEDGE_DIR = "knowledge";

/** Absolute knowledge-base directory for a workspace. */
export function knowledgeRoot(projectRoot: string, dirName?: string): string {
  const dir = dirName && dirName.trim().length > 0 ? dirName.trim() : DEFAULT_KNOWLEDGE_DIR;
  return path.join(projectRoot, dir);
}

/** Absolute path of one article file (`<id>.md`). */
export function articleFilePath(projectRoot: string, id: string, dirName?: string): string {
  return path.join(knowledgeRoot(projectRoot, dirName), `${sanitizeId(id)}.md`);
}

function toArticle(projectRoot: string, file: string, raw: string): KnowledgeArticle {
  const { meta, body } = parseFrontmatter(raw);
  const fallbackId = path.basename(file).replace(/\.md$/i, "");
  return {
    id: meta.id || fallbackId,
    title: meta.title || fallbackId,
    tags: (meta.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    owner: meta.owner,
    updatedAt: meta.updatedAt,
    path: path.relative(projectRoot, file).split(path.sep).join("/"),
    body,
    raw,
  };
}

/** All articles in the knowledge base, sorted by id. */
export function listArticles(projectRoot: string, dirName?: string): KnowledgeArticle[] {
  const dir = knowledgeRoot(projectRoot, dirName);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const articles: KnowledgeArticle[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const file = path.join(dir, entry.name);
    articles.push(toArticle(projectRoot, file, fs.readFileSync(file, "utf8")));
  }
  return articles.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read one article by id; returns undefined when it does not exist. */
export function readArticle(
  projectRoot: string,
  id: string,
  dirName?: string,
): KnowledgeArticle | undefined {
  const file = articleFilePath(projectRoot, id, dirName);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return toArticle(projectRoot, file, raw);
}

export interface ArticleMatch {
  article: KnowledgeArticle;
  snippet: string;
}

/** Ranked full-text search over the knowledge base. */
export function searchArticles(
  projectRoot: string,
  query: string,
  maxResults = 5,
  dirName?: string,
): ArticleMatch[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored: Array<ArticleMatch & { score: number }> = [];
  for (const article of listArticles(projectRoot, dirName)) {
    const haystack = `${article.id}\n${article.title}\n${article.tags.join(" ")}\n${article.body}`.toLowerCase();
    const score = scoreTerms(haystack, terms);
    if (score === 0) continue;
    scored.push({ article, snippet: snippetFor(article.body, terms), score });
  }
  scored.sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id));
  return scored.slice(0, maxResults).map(({ article, snippet }) => ({ article, snippet }));
}
