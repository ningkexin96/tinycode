import fs from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { articleFilePath, readArticle, searchArticles } from "../domain/knowledge.js";
import type { KnowledgeArticle } from "../domain/types.js";
import { diffStats, lineDiff, renderDiff } from "./diff.js";
import type { DomainToolContext } from "./context.js";

/** Render one article with its metadata header. */
export function renderArticle(article: KnowledgeArticle, withBody = true): string {
  const header = [
    `# ${article.title}`,
    `id: ${article.id} · 路径: ${article.path}`,
    `标签: ${article.tags.length > 0 ? article.tags.join(", ") : "（无）"}${
      article.owner ? ` · 负责: ${article.owner}` : ""
    }${article.updatedAt ? ` · 更新: ${article.updatedAt}` : ""}`,
  ].join("\n");
  return withBody ? `${header}\n\n${article.body}` : header;
}

const searchSchema = Type.Object({
  query: Type.String({ description: "检索关键词，例如 退款 时效 拆封" }),
  max_results: Type.Optional(Type.Number({ description: "最多返回多少篇（默认 5）" })),
});

/** search_knowledge — 在知识库中检索相关 SOP/政策。 */
export function createSearchKnowledgeTool(ctx: DomainToolContext): AgentTool<typeof searchSchema> {
  return {
    name: "search_knowledge",
    label: "Search Knowledge",
    description:
      "在知识库（knowledge/*.md）中按关键词检索 SOP/政策，返回文章 id、标题、标签与命中片断。" +
      "需要正文时用 read_article。",
    parameters: searchSchema,
    execute: async (_toolCallId, params) => {
      const matches = searchArticles(
        ctx.projectRoot,
        params.query,
        params.max_results ?? 5,
        ctx.knowledgeDir,
      );
      const text =
        matches.length === 0
          ? `知识库中没有命中「${params.query}」的文章。`
          : matches
              .map(
                (match) =>
                  `- ${match.article.id} · ${match.article.title}` +
                  `${match.article.tags.length > 0 ? ` [${match.article.tags.join(", ")}]` : ""}\n  ↳ ${match.snippet}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          count: matches.length,
          articles: matches.map((match) => ({
            id: match.article.id,
            title: match.article.title,
            tags: match.article.tags,
          })),
        },
      };
    },
  };
}

const readSchema = Type.Object({
  article_id: Type.String({ description: "知识库文章 id，例如 refund-policy" }),
});

/** read_article — 读取知识库文章正文。 */
export function createReadArticleTool(ctx: DomainToolContext): AgentTool<typeof readSchema> {
  return {
    name: "read_article",
    label: "Read Article",
    description: "按 id 读取知识库文章正文（含标签/负责人等元信息）。",
    parameters: readSchema,
    execute: async (_toolCallId, params) => {
      const article = readArticle(ctx.projectRoot, params.article_id, ctx.knowledgeDir);
      if (!article) {
        throw new Error(
          `知识库文章不存在: ${params.article_id}（先用 search_knowledge 找到正确的 id）`,
        );
      }
      return {
        content: [{ type: "text", text: renderArticle(article) }],
        details: { id: article.id, title: article.title, path: article.path },
      };
    },
  };
}

const proposeSchema = Type.Object({
  article_id: Type.String({ description: "要修改的知识库文章 id" }),
  old_text: Type.String({ description: "文章中被替换的原文（必须与文件内容完全一致）" }),
  new_text: Type.String({ description: "替换后的新文本" }),
  rationale: Type.String({ description: "修改理由（会展示给审批人）" }),
});

export interface KnowledgeEditDetails {
  article_id: string;
  additions: number;
  deletions: number;
  diff: string;
  rationale: string;
  applied: boolean;
}

/**
 * propose_knowledge_edit — 知识库写入前审查（Diff + 人工审批）。
 *
 * 权限门在 execute 之前执行：
 * - old_text === new_text        → 短路跳过（allow，不触发审批，也不落盘）；
 * - 其余情况                      → ASK，必须人工审批；无审批通道（无头模式）时阻塞。
 * 只有审批通过后本工具才会真正改写文章文件。
 */
export function createProposeKnowledgeEditTool(
  ctx: DomainToolContext,
): AgentTool<typeof proposeSchema> {
  return {
    name: "propose_knowledge_edit",
    label: "Propose Knowledge Edit",
    description:
      "对知识库文章提出精确文本修改。工具会生成统一 Diff 并交由人工审批，" +
      "未获批准不会落盘；若 old_text 与 new_text 相同则短路跳过。用于修正过期/错误 SOP。",
    parameters: proposeSchema,
    execute: async (_toolCallId, params) => {
      const file = articleFilePath(ctx.projectRoot, params.article_id, ctx.knowledgeDir);
      let current: string;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        throw new Error(
          `知识库文章不存在: ${params.article_id}（先用 search_knowledge 找到正确的 id）`,
        );
      }

      // 短路分支：无变化直接跳过，不写盘。
      if (params.old_text === params.new_text) {
        const details: KnowledgeEditDetails = {
          article_id: params.article_id,
          additions: 0,
          deletions: 0,
          diff: "",
          rationale: params.rationale,
          applied: false,
        };
        return {
          content: [
            { type: "text", text: `old_text 与 new_text 相同，无需修改 ${params.article_id}（已短路跳过）。` },
          ],
          details,
        };
      }

      if (params.old_text.length === 0) {
        throw new Error("old_text 不能为空 —— 请提供要被替换的原文。");
      }
      const occurrences = current.split(params.old_text).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `在 ${params.article_id} 中找不到 old_text。请先用 read_article 读取，然后逐字复制原文。`,
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_text 在 ${params.article_id} 中匹配到 ${occurrences} 处，请提供更多上下文使其唯一。`,
        );
      }

      const updated = current.replace(params.old_text, params.new_text);
      const diffLines = lineDiff(current.split("\n"), updated.split("\n"));
      const stats = diffStats(diffLines);
      const diff = renderDiff(diffLines);

      fs.writeFileSync(file, updated, "utf8");

      const details: KnowledgeEditDetails = {
        article_id: params.article_id,
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
        rationale: params.rationale,
        applied: true,
      };
      return {
        content: [
          {
            type: "text",
            text:
              `已通过审批并更新知识库 ${params.article_id}（+${stats.additions} -${stats.deletions}）\n` +
              `理由: ${params.rationale}\n\n${diff}`,
          },
        ],
        details,
      };
    },
  };
}
