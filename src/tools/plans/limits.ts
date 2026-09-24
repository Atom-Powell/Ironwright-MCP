/**
 * A coarse pre-check against an obviously oversized plan, refused before a
 * single Graph request is spent rather than after the etag fetch loop. It is
 * not the real ceiling: the store's actual bound is `MAX_PLAN_JSON_CHARS`
 * (32000 characters across `items` and `excluded` combined), and a realistic
 * item serializes to roughly 274 characters, so the true limit is closer to
 * 116 items with `excluded` unbounded. This number exists only so a plan far
 * past any reasonable size fails fast, with a remedy a caller can act on,
 * before the etag fetch loop runs at all; `savePlan` is what actually enforces
 * the character cap, in both StateStore implementations.
 */
export const MAX_PLAN_ITEMS = 200;

/**
 * The most items and exclusions one response lists. The stored plan holds every
 * one of them; `itemCount` and `excludedCount` are computed before this cut, so
 * a reader always learns the true size even when the listing is a prefix.
 */
export const MAX_PLAN_ITEMS_LISTED = 50;
