/**
 * Liquid-glass material tokens.
 *
 * The vocabulary follows Apple's WWDC25 "Liquid Glass" recipe — refractive
 * translucency, a specular highlight along the top edge, and adaptive
 * tinting against the content beneath. The implementation is CSS-only
 * (backdrop-filter + inset shadows + a top-edge highlight gradient) so it
 * works in every browser that ships backdrop-filter, with a graceful
 * fallback to the solid `bg-paper` token when the user prefers reduced
 * transparency.
 *
 * Variants (use the one that matches the surface's ROLE):
 *   GLASS_BAR    — full-width chrome (top app bar, bottom tab bar). Thin
 *                  vertical, lensing edge on both sides, scroll-edge fade.
 *   GLASS_SHEET  — modal sheets + popovers springing from a trigger. Large
 *                  blur, paired with a dim layer behind.
 *   GLASS_CARD   — large floating panels (AI pill, verse toolbar). 28px
 *                  corner radius matches the 64px pills.
 *   GLASS_PILL   — capsule-shaped floating buttons (toolbar action chips).
 *   GLASS_INSET  — inline cards inside scrolling panes (notes, bookmarks,
 *                  rail rows, tip cards). 18px radius keeps stacked lists
 *                  tight.
 *
 * Modifiers:
 *   GLASS_INTERACTIVE  — add to a clickable glass element. Adds press-state
 *                        elastic feedback (inner glow on :active) so the
 *                        material reads as alive without a JS event handler.
 *   GLASS_SPECULAR     — adds an absolutely-positioned highlight overlay
 *                        via the `glass-specular` class (see index.css).
 *
 * Apple HIG explicitly forbids glass on content layer (lists, cells,
 * reading text). Don't apply these to scripture text, chat bubbles, or
 * note bodies — they belong to the content layer and get solid surfaces.
 */

// Shared adaptive surface: translucent paper in light, translucent neutral
// in dark, with the saturate(180%) bump Apple specifies so the underlying
// content's color shows through with character.
const SURFACE_BG =
  "bg-paper/55 backdrop-blur-2xl backdrop-saturate-[1.8] " +
  "dark:bg-neutral-900/45";

const SURFACE_BG_HEAVY =
  "bg-paper/70 backdrop-blur-[40px] backdrop-saturate-[1.8] " +
  "dark:bg-neutral-900/55";

// 1px hairline border that picks up the underlying content's tint —
// Apple's "lensing edge" effect, faked with a semi-transparent border.
const RIM_LIGHT = "border border-white/40 dark:border-white/10";
const RIM_HEAVY = "border border-white/50 dark:border-white/15";

// Specular highlight: bright 1px stripe along the TOP inside edge, dim 1px
// along the BOTTOM. Stronger in light mode (the highlight is brighter than
// the surface) and very subtle in dark mode.
const SPECULAR_LARGE =
  "shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_0_rgba(0,0,0,0.06)] " +
  "dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10),inset_0_-1px_0_rgba(0,0,0,0.20)]";

const SPECULAR_SMALL =
  "shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(0,0,0,0.05)] " +
  "dark:shadow-[0_4px_14px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.15)]";

const SPECULAR_BAR =
  "shadow-[0_1px_0_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] " +
  "dark:shadow-[0_1px_0_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]";

// Public variants ------------------------------------------------------

/** Top / bottom navigation bar. Thin, no corner radius, lensing edges. */
export const GLASS_BAR =
  `${SURFACE_BG} ${RIM_LIGHT} ${SPECULAR_BAR} ` +
  // Hairline only on the relevant edge — set border on top OR bottom by
  // composing with `border-t-0` / `border-b-0` at the call site if needed.
  `relative`;

/** Modal sheet / large floating popover. Use with a dim layer behind. */
export const GLASS_SHEET =
  `rounded-[28px] ${SURFACE_BG_HEAVY} ${RIM_HEAVY} ${SPECULAR_LARGE} relative`;

/** Large floating card (AI pill, verse toolbar). */
export const GLASS_CARD =
  `rounded-[28px] ${SURFACE_BG} ${RIM_LIGHT} ${SPECULAR_LARGE} relative`;

/** Capsule-shaped pill (action chips, toggle pills). */
export const GLASS_PILL =
  `rounded-full ${SURFACE_BG} ${RIM_LIGHT} ${SPECULAR_SMALL} relative`;

/** Inline card inside a scrolling pane. 18px radius, lighter shadow. */
export const GLASS_INSET =
  `rounded-[18px] ${SURFACE_BG} ${RIM_LIGHT} ${SPECULAR_SMALL} relative`;

/**
 * Interactive modifier — adds press-state elastic feedback. Apple's
 * Liquid Glass "illuminates from within" on touch; we approximate with
 * an active-state inner glow + a fast micro-scale.
 *
 * Apply *in addition to* a glass variant on any clickable surface.
 */
export const GLASS_INTERACTIVE =
  "transition-[transform,box-shadow] duration-150 ease-out " +
  "active:scale-[0.97] " +
  "active:shadow-[0_2px_10px_rgba(0,0,0,0.14),inset_0_0_18px_rgba(255,255,255,0.30),inset_0_1px_0_rgba(255,255,255,0.55)] " +
  "dark:active:shadow-[0_2px_10px_rgba(0,0,0,0.55),inset_0_0_18px_rgba(255,255,255,0.10),inset_0_1px_0_rgba(255,255,255,0.10)]";

/**
 * Specular sweep modifier — paint a moving highlight across the surface
 * on hover. Requires the `glass-specular` CSS class defined in index.css
 * (which uses ::after to draw the 135° gradient). Skip on prefers-
 * reduced-motion (handled in the CSS).
 */
export const GLASS_SPECULAR = "glass-specular";

// Back-compat shims so older call sites keep working until they migrate.
export const GLASS_CARD_INLINE = GLASS_INSET;
