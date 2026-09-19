/** Sanitize an externally supplied id into a safe file stem. */
export function sanitizeId(id: string): string {
  return id
    .replace(/\.(md|json)$/i, "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}
