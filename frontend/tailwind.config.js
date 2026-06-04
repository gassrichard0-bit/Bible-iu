/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Uncertainty UI palette (CLAUDE.md §4.7). Light + dark pairs so
        // hierarchy survives the theme switch.
        scripture: "#f5efe1",
        "scripture-dark": "#3b3320",
        commentary: "#dde7f3",
        "commentary-dark": "#1e2a3a",
        inference: "#efe4f4",
        "inference-dark": "#2e1f3b",
        // Warm reading surfaces — used in light mode to dim the
        // glare from pure white. Dark mode keeps neutral-900.
        paper: "#f7f3ea",
        "paper-soft": "#efe9d9",
      },
      keyframes: {
        "bible-sheet-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
      },
      animation: {
        "bible-sheet-up": "bible-sheet-up 220ms cubic-bezier(0.32, 0.72, 0, 1)",
      },
    },
  },
  plugins: [],
};
