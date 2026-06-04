/**
 * Zoom-out level 3 (max). Two big cards — Old Testament and New
 * Testament — for jumping between the two halves of scripture.
 * Lives in the Bible panel, replacing both BibleView and TestamentGrid
 * when active.
 */
import {
  NT_BOOKS,
  OT_BOOKS,
  type Testament,
  testamentOf,
} from "../lib/testament";
import { GLASS_CARD } from "../lib/glass";

interface Props {
  currentBook: string;
  onPickTestament: (t: Testament) => void;
}

export function BibleOverview({ currentBook, onPickTestament }: Props) {
  const currentTestament = testamentOf(currentBook);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-paper px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold">The Bible</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid h-full gap-4 md:grid-cols-2">
          <TestamentCard
            label="Old Testament"
            books={OT_BOOKS.length}
            highlight={currentTestament === "OT"}
            onClick={() => onPickTestament("OT")}
          />
          <TestamentCard
            label="New Testament"
            books={NT_BOOKS.length}
            highlight={currentTestament === "NT"}
            onClick={() => onPickTestament("NT")}
          />
        </div>
      </div>
    </div>
  );
}

function TestamentCard({
  label,
  books,
  highlight,
  onClick,
}: {
  label: string;
  books: number;
  highlight: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-full min-h-32 flex-col items-center justify-center p-6 text-center transition ${GLASS_CARD} ${
        highlight
          ? "ring-2 ring-neutral-900/70 dark:ring-neutral-100/70"
          : "hover:ring-1 hover:ring-neutral-400/60 dark:hover:ring-neutral-500/60"
      }`}
      aria-label={`Open ${label}`}
      aria-current={highlight ? "true" : undefined}
    >
      <span className="text-lg font-semibold">{label}</span>
      <span className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {books} books
      </span>
    </button>
  );
}
