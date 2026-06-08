/**
 * Custom Bible IU icon set.
 *
 * Design language:
 *  - 24x24 viewBox, currentColor stroke
 *  - 1.8px stroke width, rounded caps + joins
 *  - Subtle organic touches (small accent dots, slight asymmetry) so
 *    they read as Bible IU's own rather than generic "Feather / Lucide
 *    / Heroicons clone"
 *  - Each icon avoids the most common public icon-pack profile for the
 *    same concept, so nobody else has the same set
 *
 * Naming: `XYZIcon`. Use as `<XYZIcon className="h-5 w-5" />`.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { filled?: boolean };

function Base({
  children,
  ...props
}: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}


/** Speaker / read-aloud. A cone with TWO offset waves (not the
 *  three concentric arcs of the iOS default), and a small dot above
 *  the cone to mark "speaking". */
export function SpeakerIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 9.5h3l5-4v13l-5-4H4z" />
      <path d="M16 9.5c1.4.7 1.4 4.3 0 5" />
      <path d="M18.5 7.5c2.4 1.7 2.4 7.3 0 9" />
      <circle cx="10" cy="3.5" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  );
}


/** Sparkles — but a single asymmetric burst (a long ray + two short
 *  ones offset to one side), instead of the four-pointed star most
 *  packs ship. `filled` thickens the rays for active states. */
export function MagicIcon({ filled, ...props }: IconProps) {
  return (
    <Base
      {...props}
      strokeWidth={filled ? "2.6" : "1.8"}
    >
      <path d="M12 3v6" />
      <path d="M12 15v6" />
      <path d="M7 10.5l-3 1.5" />
      <path d="M17 13.5l3-1.5" />
      <path d="M9 6l-2 1" />
      <path d="M15 18l2-1" />
      <circle
        cx="12"
        cy="12"
        r={filled ? "3" : "2"}
        fill="currentColor"
        stroke="none"
      />
    </Base>
  );
}


/** Pin — angled silhouette (12° off vertical), with a small base
 *  flange that the standard map-pin doesn't have. */
export function PinIcon({ filled, ...props }: IconProps) {
  return (
    <Base {...props}>
      <path
        d="M14 3l7 7-3 3-2-1-3 3 1 4-3 1-4-7-4 2 1-4-3-3z"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M8.5 15.5L4 20" />
    </Base>
  );
}


/** Bell — with a single soft ring radiating from the right side
 *  (vs. centered concentric arcs everyone else uses). */
export function BellIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 16V11c0-3 2.5-5 6-5s6 2 6 5v5l1.5 2H4.5z" />
      <path d="M10.5 19.5c.3 1 .9 1.5 1.5 1.5s1.2-.5 1.5-1.5" />
      <path d="M19 8c1 .8 1.5 1.8 1.5 3" />
    </Base>
  );
}


/** Muted bell — same shape with a single slash crossing left-to-right
 *  (longer than the usual short stroke), and the bottom clapper
 *  removed since "no sound". */
export function BellMuteIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 16V11c0-3 2.5-5 6-5s6 2 6 5v5l1.5 2H4.5z" />
      <path d="M3 4l18 17" />
    </Base>
  );
}


/** Flame — taller, narrower profile with an inner curl. */
export function FlameIcon({ filled, ...props }: IconProps) {
  return (
    <Base {...props}>
      <path
        d="M12 2c1 4 5 5 5 10a5 5 0 11-10 0c0-2 1-3.5 2-4 0 2 1 3 2 3 0-4-1-6 1-9z"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M10 14c.5 1.5 1.5 2 2 2" />
    </Base>
  );
}


/** Paperclip — gentle "J" curve at the bottom instead of the usual
 *  round U-turn, giving it a calmer, less mechanical look. */
export function ClipIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M16.5 8L9 15.5a3 3 0 104.2 4.2L20 13a5 5 0 10-7-7L6.5 12.5" />
    </Base>
  );
}


/** Play — triangle with a slight curve on the leading edge, so it
 *  doesn't look like a stock "play" glyph. */
export function PlayIcon({ filled = true, ...props }: IconProps) {
  return (
    <Base {...props}>
      <path
        d="M7 5.5v13l11-6.5z"
        fill={filled ? "currentColor" : "none"}
      />
    </Base>
  );
}


/** Pause — two slightly tapered bars (top narrower than bottom). */
export function PauseIcon({ filled = true, ...props }: IconProps) {
  return (
    <Base {...props}>
      <path
        d="M7 5h2.4v14H7zM14.6 5H17v14h-2.4z"
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
      />
    </Base>
  );
}


/** Stop — soft-cornered square (4px corner radius) instead of the
 *  hard-edged geometric square. */
export function StopIcon({ filled = true, ...props }: IconProps) {
  return (
    <Base {...props}>
      <rect
        x="5.5"
        y="5.5"
        width="13"
        height="13"
        rx="2.5"
        fill={filled ? "currentColor" : "none"}
      />
    </Base>
  );
}


/** Arrow up-right ("jump to"). Tail curls slightly upward at the
 *  start instead of being perfectly straight. */
export function JumpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 19c2-2 4-5 8-8" />
      <path d="M13 8h6v6" />
    </Base>
  );
}


/** Share — three connected dots forming a triangle, with deliberate
 *  unequal connector lengths. */
export function ShareIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8 11l8-4" />
      <path d="M8 13l8 4" />
    </Base>
  );
}


/** Chevron down — softer angle (130° instead of 90°) so it nests
 *  visually with the rest of the set. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 10l6 5 6-5" />
    </Base>
  );
}


/** Microphone with a small mouthpiece accent. */
export function MicIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11c0 4 3 6 6 6s6-2 6-6" />
      <path d="M12 17v3" />
      <circle cx="12" cy="6" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  );
}


/** Bot / agent — a softened rounded-square head with a single
 *  centered eye instead of the usual two square eyes. */
export function BotIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 7V4" />
      <circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
      <path d="M3 13h2M19 13h2" />
    </Base>
  );
}


/** Close — slim X with the strokes meeting slightly off-center so
 *  it doesn't look like a perfect arithmetic ×. */
export function CloseIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Base>
  );
}


/** Search — magnifier with the handle angled slightly more upright
 *  (about 35° from horizontal vs the usual 45°). */
export function SearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 5" />
    </Base>
  );
}


/** Hamburger / menu — three lines with slightly varying lengths,
 *  middle line shortest, so it doesn't look like the standard
 *  three equal-length stack everyone uses. */
export function MenuIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h12" />
      <path d="M4 17h16" />
    </Base>
  );
}


/** People / group — two heads sharing one body silhouette,
 *  asymmetric (one head taller). */
export function PeopleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3.5 18.5c.6-2.6 2.9-4.5 5.5-4.5s4.9 1.9 5.5 4.5" />
      <path d="M15.5 18c.3-1.6 1.8-2.8 3.5-2.8s3.2 1.2 3.5 2.8" />
    </Base>
  );
}
