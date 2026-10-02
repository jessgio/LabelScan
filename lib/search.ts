/** Escape LIKE/ILIKE wildcards so a search is a literal substring match. */
export function escapeIlike(term: string) {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
