/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    // Class names used by the published @ima-jin/ui components (NavBar, footer, ...).
    './node_modules/@ima-jin/ui/dist/**/*.{js,cjs}',
  ],
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [],
};
