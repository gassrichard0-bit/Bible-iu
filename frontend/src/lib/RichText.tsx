/**
 * Renders prose with inline verse-reference buttons.
 *
 * Detects patterns like "John 3:16", "1 Corinthians 13:4", "Ps. 23:1"
 * and renders each match as a click-to-jump button. Surrounding text is
 * rendered as plain spans so it still wraps naturally.
 */
import { osisFromHuman } from "./api";

const VERSE_RE =
  /\b((?:[123]\s*)?[A-Za-z]+(?:\s+of\s+[A-Za-z]+)?)\.?\s+(\d{1,3}):(\d{1,3})\b/g;

interface Props {
  text: string;
  onJump: (source_id: string) => void;
  className?: string;
}

export function RichText({ text, onJump, className }: Props) {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex because the regex is `g`-flagged and module-scoped.
  VERSE_RE.lastIndex = 0;
  let n = 0;
  while ((match = VERSE_RE.exec(text)) !== null) {
    const [whole, book, chapter, verse] = match;
    const ref = osisFromHuman(book, chapter, verse);
    if (ref === null) continue;
    if (match.index > last) {
      parts.push(<span key={`t-${n}`}>{text.slice(last, match.index)}</span>);
    }
    parts.push(
      <button
        key={`r-${n}`}
        onClick={() => onJump(ref)}
        className="rounded bg-paper-soft px-1 py-0.5 text-[0.97em] text-neutral-800 underline decoration-neutral-400 underline-offset-2 hover:bg-yellow-100 dark:bg-neutral-800 dark:text-neutral-100 dark:decoration-neutral-500 dark:hover:bg-amber-900/40"
        title={`Jump to ${ref}`}
      >
        {whole}
      </button>,
    );
    last = match.index + whole.length;
    n += 1;
  }
  if (last < text.length) {
    parts.push(<span key="tail">{text.slice(last)}</span>);
  }
  return <span className={className}>{parts}</span>;
}
