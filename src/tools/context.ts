/**
 * Shared context passed to every domain tool factory.
 *
 * `knowledgeDir` / `ticketsDir` come from `.tinycode/config.json` (defaults
 * `knowledge` / `tickets`). `now` is injectable so tests can pin timestamps.
 */
export interface DomainToolContext {
  projectRoot: string;
  knowledgeDir?: string;
  ticketsDir?: string;
  now?: () => string;
}

/** Current ISO timestamp (overridable for deterministic tests). */
export function nowIso(ctx: DomainToolContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}
