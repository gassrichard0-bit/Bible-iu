/**
 * Zoom-out level 2: shows every book in the selected testament as a
 * tap-target grid. Replaces the BibleView in the Bible panel while
 * the user is at this zoom level.
 *
 * Clicking a book hands the selection back to Workspace, which
 * navigates to that book + chapter 1 and exits testament view.
 */
import {
  booksInTestament,
  type Testament,
  testamentName,
} from "../lib/testament";

interface Props {
  testament: Testament;
  currentBook: string;
  onPickBook: (book: string) => void;
}

export function TestamentGrid({
  testament,
  currentBook,
  onPickBook,
}: Props) {
  const books = booksInTestament(testament);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-paper px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold">{testamentName(testament)}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {books.map((b) => {
            const isCurrent = b.code === currentBook;
            return (
              <button
                key={b.code}
                onClick={() => onPickBook(b.code)}
                className={`flex min-h-[52px] items-center justify-center rounded-2xl border px-3 text-[14px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.45)] transition active:scale-[0.98] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)] ${
                  isCurrent
                    ? "border-amber-300 bg-amber-50/80 font-semibold text-amber-900 ring-2 ring-amber-200/50 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100 dark:ring-amber-800/40"
                    : "border-neutral-200 bg-paper text-neutral-800 hover:border-neutral-300 hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                }`}
                aria-label={`Open ${b.name}`}
                aria-current={isCurrent ? "true" : undefined}
              >
                <span className="truncate">{b.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
