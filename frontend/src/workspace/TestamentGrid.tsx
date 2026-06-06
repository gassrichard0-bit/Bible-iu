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
                className={`flex h-14 items-center justify-center rounded border px-2 text-sm transition ${
                  isCurrent
                    ? "border-neutral-900 bg-paper-soft font-semibold text-neutral-900 dark:border-neutral-100 dark:bg-neutral-800 dark:text-neutral-100"
                    : "border-neutral-200 bg-paper text-neutral-700 hover:border-neutral-400 hover:bg-paper-soft dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800"
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
