/**
 * Shared "liquid glass" material — the same recipe used by the
 * bottom AI pill, the floating tab bar, and the verse annotation
 * toolbar. Centralized here so every card-shaped surface in the app
 * reads as the same material instead of drifting class-by-class.
 *
 * Two sizes:
 *   `GLASS_CARD`         — large floating panels (pill, toolbar).
 *                          28px corner radius matches the 64px pills.
 *   `GLASS_CARD_INLINE`  — list items / inline cards inside scrolling
 *                          panes (notes, bookmarks, tip cards). 18px
 *                          radius keeps them tight in stacked lists.
 *
 * Both carry the same border / surface / blur so the material is
 * recognizable regardless of where it lands. Apply on top of your
 * layout classes — never inside, never as a replacement for padding.
 */

const SURFACE =
  "border border-white/40 bg-paper/55 backdrop-blur-2xl backdrop-saturate-200 " +
  "dark:border-white/10 dark:bg-neutral-900/45";

const SHADOW_LARGE =
  "shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] " +
  "dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]";

const SHADOW_INLINE =
  "shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] " +
  "dark:shadow-[0_4px_14px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]";

export const GLASS_CARD = `rounded-[28px] ${SURFACE} ${SHADOW_LARGE}`;
export const GLASS_CARD_INLINE = `rounded-[18px] ${SURFACE} ${SHADOW_INLINE}`;
