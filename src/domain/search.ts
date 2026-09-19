/**
 * Tiny full-text helpers shared by the ticket and knowledge search tools.
 * Deterministic and offline: no index, no dependencies.
 */

/** Split a query into lowercase terms. */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Count how many terms appear anywhere in `haystack` (already lowercased). */
export function scoreTerms(haystack: string, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/** Return the first line that contains any term, clipped for display. */
export function snippetFor(text: string, terms: readonly string[], maxChars = 160): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (terms.some((term) => lowered.includes(term))) {
      const trimmed = line.trim();
      return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
    }
  }
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  return first.length > maxChars ? `${first.slice(0, maxChars)}…` : first;
}
