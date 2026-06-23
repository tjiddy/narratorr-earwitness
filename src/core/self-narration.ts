import type { Attribution } from '../shared/schemas/result.js';

// A narrator credited by ROLE rather than name — "read by the author", "narrated by the writer".
// Whisper hears it verbatim, extraction surfaces the literal role word, and it then reads as a
// CONTRADICTION against narratorr's real (named) narrator — a false mismatch on self-narrated books
// (memoir, nonfiction: McCullough's 1776, Peterson's 12 Rules, Fey's Bossypants). The sighted LLM
// judge resolves this only intermittently, so we do it deterministically here, in detection, before
// any comparison: a role-word narrator becomes the book's detected author(s).
const SELF_ROLE_RE = /^(?:the\s+)?(?:author|writer)s?$/i;

export function isSelfNarrationRole(name: string): boolean {
  return SELF_ROLE_RE.test(name.trim());
}

/**
 * Replace any role-word narrator ("the author") with the detected author name(s), in place within
 * the narrator list, then de-duplicate case-insensitively (order preserved). No-op when no author
 * was detected (nothing to resolve to) or when no narrator is a role word.
 */
export function resolveSelfNarration(detected: Attribution): Attribution {
  if (detected.authors.length === 0) return detected;
  if (!detected.narrators.some(isSelfNarrationRole)) return detected;

  const expanded = detected.narrators.flatMap((n) => (isSelfNarrationRole(n) ? detected.authors : [n]));
  const seen = new Set<string>();
  const narrators = expanded.filter((n) => {
    const key = n.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...detected, narrators };
}
