/**
 * Render a verse + its annotations to a Canvas image, then hand off
 * to the Web Share API (or fall back to download / clipboard on
 * platforms without share). Single biggest organic-growth lever for
 * a Bible app — make it trivial to share the verse you just marked.
 *
 * Card design follows the app's "paper" palette so a shared card
 * looks like a snapshot of the reader, not a third-party graphic.
 */
import type { AnnotationOut } from "./api";

interface BuildCardArgs {
  verseId: string;          // "JHN.3.16"
  verseLabel: string;       // "John 3:16"
  translation: string;      // "King James Version"
  text: string;             // the actual verse text
  annotations?: AnnotationOut[]; // user's marks on this verse
}

const W = 1080;             // 1080×1080 — Instagram square, iMessage friendly
const H = 1080;
const PAD = 80;
const BG = "#f7f3ea";       // bg-paper-soft
const FG = "#171717";       // neutral-900
const MUTED = "#8a857c";    // brand-soft muted
const PALETTE: Record<string, string> = {
  yellow: "#fbbf24",        // amber-400
  green: "#10b981",         // emerald-500
  blue: "#0ea5e9",          // sky-500
  pink: "#ec4899",          // pink-500
  orange: "#f97316",        // orange-500
};

/** Renders the card and returns it as a `Blob`. */
async function buildCard(args: BuildCardArgs): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // Background.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Find the strongest annotation (highlight wins over underline wins
  // over box) so the card subtly hints at how the reader marked it.
  const ann = (args.annotations || []).filter(
    (a) => a.verse_id === args.verseId,
  );
  const highlight = ann.find((a) => a.kind === "highlight");
  const underline =
    ann.find((a) => a.kind === "wavy") ||
    ann.find((a) => a.kind === "double_underline") ||
    ann.find((a) => a.kind === "underline");
  const box = ann.find((a) => a.kind === "box");
  const bold = ann.find((a) => a.kind === "bold");

  // Word-wrap the verse into lines at a reasonable font size.
  const maxTextWidth = W - 2 * PAD;
  const fontFamily =
    "Georgia, 'Times New Roman', ui-serif, system-ui, -apple-system, serif";
  const fontSize = pickFontSize(ctx, args.text, maxTextWidth, fontFamily);
  ctx.font = `${bold ? "700" : "400"} ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "alphabetic";

  const lines = wrap(ctx, args.text, maxTextWidth);
  const lineHeight = Math.round(fontSize * 1.35);
  const blockH = lines.length * lineHeight;
  // Vertically center the text block in the middle ~70% of the card
  // so the reference + branding sit comfortably above + below.
  const blockTop = Math.round((H - blockH) / 2 - 40);

  // Optional highlight band — a tinted ribbon behind the text.
  if (highlight) {
    ctx.fillStyle = withAlpha(PALETTE[highlight.color] || "#fbbf24", 0.32);
    ctx.fillRect(
      PAD - 16,
      blockTop - lineHeight * 0.85,
      W - 2 * (PAD - 16),
      blockH + lineHeight * 0.5,
    );
  }
  // Optional box — rounded rect around the text block.
  if (box) {
    ctx.strokeStyle = PALETTE[box.color] || FG;
    ctx.lineWidth = 6;
    roundRect(
      ctx,
      PAD - 24,
      blockTop - lineHeight * 0.95,
      W - 2 * (PAD - 24),
      blockH + lineHeight * 0.7,
      28,
    );
    ctx.stroke();
  }

  ctx.fillStyle = bold ? PALETTE[bold.color] || FG : FG;
  for (let i = 0; i < lines.length; i++) {
    const x = PAD;
    const y = blockTop + (i + 1) * lineHeight - lineHeight * 0.25;
    ctx.fillText(lines[i], x, y);
  }

  // Optional underline — drawn under the LAST line, full width of
  // that line's measured text. Wavy + double get distinct treatments.
  if (underline) {
    const last = lines[lines.length - 1];
    const lastWidth = ctx.measureText(last).width;
    const ux = PAD;
    const uy =
      blockTop + lines.length * lineHeight - lineHeight * 0.18 + 6;
    ctx.strokeStyle = PALETTE[underline.color] || FG;
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (underline.kind === "wavy") {
      const amp = 6;
      const step = 14;
      for (let xx = ux; xx <= ux + lastWidth; xx += step) {
        const yy = uy + (Math.floor((xx - ux) / step) % 2 === 0 ? amp : -amp);
        if (xx === ux) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
    } else if (underline.kind === "double_underline") {
      ctx.moveTo(ux, uy);
      ctx.lineTo(ux + lastWidth, uy);
      ctx.moveTo(ux, uy + 10);
      ctx.lineTo(ux + lastWidth, uy + 10);
    } else {
      ctx.moveTo(ux, uy);
      ctx.lineTo(ux + lastWidth, uy);
    }
    ctx.stroke();
  }

  // Reference + translation, top-left.
  ctx.fillStyle = FG;
  ctx.font = `600 28px ${fontFamily}`;
  ctx.fillText(args.verseLabel, PAD, PAD + 32);
  ctx.fillStyle = MUTED;
  ctx.font = `400 22px ${fontFamily}`;
  ctx.fillText(args.translation, PAD, PAD + 64);

  // Branding, bottom-right.
  ctx.font = `500 22px ${fontFamily}`;
  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.fillText("Bible IU", W - PAD, H - PAD);
  ctx.textAlign = "start";

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("failed to encode canvas"));
    }, "image/png");
  });
}

/** Iteratively pick a font size that fits in `<= 12` lines. */
function pickFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontFamily: string,
): number {
  // Cap at 64px for short verses, floor at 30px for very long ones.
  for (let px = 64; px >= 30; px -= 2) {
    ctx.font = `400 ${px}px ${fontFamily}`;
    const lines = wrap(ctx, text, maxWidth);
    if (lines.length <= 12) return px;
  }
  return 30;
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (ctx.measureText(trial).width > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function withAlpha(hex: string, a: number): string {
  // Quick `#rrggbb` → `rgba(...)`.
  const m = hex.replace("#", "");
  const r = parseInt(m.substring(0, 2), 16);
  const g = parseInt(m.substring(2, 4), 16);
  const b = parseInt(m.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Build the card and trigger the platform's native share sheet.
 *  Falls back to download on platforms without `navigator.share`
 *  (most desktops) or `canShare` for files (some browsers). */
export async function shareVerseCard(
  args: BuildCardArgs,
): Promise<"shared" | "downloaded"> {
  const blob = await buildCard(args);
  const filename = `${args.verseId.replaceAll(".", "-")}.png`;
  const file = new File([blob], filename, { type: "image/png" });

  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  };
  if (
    typeof nav.share === "function" &&
    typeof nav.canShare === "function" &&
    nav.canShare({ files: [file] })
  ) {
    try {
      await nav.share({
        files: [file],
        title: args.verseLabel,
        text: `${args.text} — ${args.verseLabel}`,
      });
      return "shared";
    } catch (err) {
      // User cancelled or share failed — fall through to download.
      if ((err as DOMException).name === "AbortError") return "shared";
    }
  }

  // Desktop fallback: trigger a download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
