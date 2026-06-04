/**
 * Old / New Testament book metadata.
 *
 * Codes match the 3-4 letter shorthand used everywhere else in the app
 * (see `backend/data/seed_kjv.py`). Canonical Protestant order. Each
 * book carries a friendly display name so the zoom-out testament grid
 * doesn't render bare codes.
 */
export type Testament = "OT" | "NT";

export interface BookMeta {
  code: string;
  name: string;
}

export const OT_BOOKS: BookMeta[] = [
  { code: "GEN", name: "Genesis" },
  { code: "EXO", name: "Exodus" },
  { code: "LEV", name: "Leviticus" },
  { code: "NUM", name: "Numbers" },
  { code: "DEU", name: "Deuteronomy" },
  { code: "JOS", name: "Joshua" },
  { code: "JDG", name: "Judges" },
  { code: "RUT", name: "Ruth" },
  { code: "1SA", name: "1 Samuel" },
  { code: "2SA", name: "2 Samuel" },
  { code: "1KI", name: "1 Kings" },
  { code: "2KI", name: "2 Kings" },
  { code: "1CH", name: "1 Chronicles" },
  { code: "2CH", name: "2 Chronicles" },
  { code: "EZR", name: "Ezra" },
  { code: "NEH", name: "Nehemiah" },
  { code: "EST", name: "Esther" },
  { code: "JOB", name: "Job" },
  { code: "PSA", name: "Psalms" },
  { code: "PRO", name: "Proverbs" },
  { code: "ECC", name: "Ecclesiastes" },
  { code: "SNG", name: "Song of Solomon" },
  { code: "ISA", name: "Isaiah" },
  { code: "JER", name: "Jeremiah" },
  { code: "LAM", name: "Lamentations" },
  { code: "EZK", name: "Ezekiel" },
  { code: "DAN", name: "Daniel" },
  { code: "HOS", name: "Hosea" },
  { code: "JOL", name: "Joel" },
  { code: "AMO", name: "Amos" },
  { code: "OBA", name: "Obadiah" },
  { code: "JON", name: "Jonah" },
  { code: "MIC", name: "Micah" },
  { code: "NAM", name: "Nahum" },
  { code: "HAB", name: "Habakkuk" },
  { code: "ZEP", name: "Zephaniah" },
  { code: "HAG", name: "Haggai" },
  { code: "ZEC", name: "Zechariah" },
  { code: "MAL", name: "Malachi" },
];

export const NT_BOOKS: BookMeta[] = [
  { code: "MAT", name: "Matthew" },
  { code: "MRK", name: "Mark" },
  { code: "LUK", name: "Luke" },
  { code: "JHN", name: "John" },
  { code: "ACT", name: "Acts" },
  { code: "ROM", name: "Romans" },
  { code: "1CO", name: "1 Corinthians" },
  { code: "2CO", name: "2 Corinthians" },
  { code: "GAL", name: "Galatians" },
  { code: "EPH", name: "Ephesians" },
  { code: "PHP", name: "Philippians" },
  { code: "COL", name: "Colossians" },
  { code: "1TH", name: "1 Thessalonians" },
  { code: "2TH", name: "2 Thessalonians" },
  { code: "1TI", name: "1 Timothy" },
  { code: "2TI", name: "2 Timothy" },
  { code: "TIT", name: "Titus" },
  { code: "PHM", name: "Philemon" },
  { code: "HEB", name: "Hebrews" },
  { code: "JAS", name: "James" },
  { code: "1PE", name: "1 Peter" },
  { code: "2PE", name: "2 Peter" },
  { code: "1JN", name: "1 John" },
  { code: "2JN", name: "2 John" },
  { code: "3JN", name: "3 John" },
  { code: "JUD", name: "Jude" },
  { code: "REV", name: "Revelation" },
];

const OT_SET = new Set(OT_BOOKS.map((b) => b.code));
const NT_SET = new Set(NT_BOOKS.map((b) => b.code));

export function testamentOf(book: string): Testament | null {
  if (OT_SET.has(book)) return "OT";
  if (NT_SET.has(book)) return "NT";
  return null;
}

export function booksInTestament(t: Testament): BookMeta[] {
  return t === "OT" ? OT_BOOKS : NT_BOOKS;
}

export function testamentName(t: Testament): string {
  return t === "OT" ? "Old Testament" : "New Testament";
}

/** Per-book color palette for bookmark dividers / cards. A fixed
 *  16-hue rainbow indexed by canonical book order so each Bible book
 *  has a stable, visually distinct color in both light and dark mode. */
const BOOK_PALETTE = [
  {
    line: "bg-amber-400/80 dark:bg-amber-300/70",
    text: "text-amber-700 dark:text-amber-300",
  },
  {
    line: "bg-rose-400/80 dark:bg-rose-300/70",
    text: "text-rose-700 dark:text-rose-300",
  },
  {
    line: "bg-sky-400/80 dark:bg-sky-300/70",
    text: "text-sky-700 dark:text-sky-300",
  },
  {
    line: "bg-emerald-400/80 dark:bg-emerald-300/70",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  {
    line: "bg-violet-400/80 dark:bg-violet-300/70",
    text: "text-violet-700 dark:text-violet-300",
  },
  {
    line: "bg-fuchsia-400/80 dark:bg-fuchsia-300/70",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
  },
  {
    line: "bg-teal-400/80 dark:bg-teal-300/70",
    text: "text-teal-700 dark:text-teal-300",
  },
  {
    line: "bg-indigo-400/80 dark:bg-indigo-300/70",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  {
    line: "bg-orange-400/80 dark:bg-orange-300/70",
    text: "text-orange-700 dark:text-orange-300",
  },
  {
    line: "bg-lime-400/80 dark:bg-lime-300/70",
    text: "text-lime-700 dark:text-lime-300",
  },
  {
    line: "bg-cyan-400/80 dark:bg-cyan-300/70",
    text: "text-cyan-700 dark:text-cyan-300",
  },
  {
    line: "bg-pink-400/80 dark:bg-pink-300/70",
    text: "text-pink-700 dark:text-pink-300",
  },
  {
    line: "bg-blue-400/80 dark:bg-blue-300/70",
    text: "text-blue-700 dark:text-blue-300",
  },
  {
    line: "bg-green-400/80 dark:bg-green-300/70",
    text: "text-green-700 dark:text-green-300",
  },
  {
    line: "bg-yellow-400/80 dark:bg-yellow-300/70",
    text: "text-yellow-700 dark:text-yellow-300",
  },
  {
    line: "bg-red-400/80 dark:bg-red-300/70",
    text: "text-red-700 dark:text-red-300",
  },
];

const _BOOK_INDEX = new Map<string, number>();
[...OT_BOOKS, ...NT_BOOKS].forEach((b, i) => _BOOK_INDEX.set(b.code, i));

export function bookColor(code: string): {
  line: string;
  text: string;
} {
  const idx = _BOOK_INDEX.get(code);
  if (idx === undefined) return BOOK_PALETTE[0];
  return BOOK_PALETTE[idx % BOOK_PALETTE.length];
}
