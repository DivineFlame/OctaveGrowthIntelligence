/** @type {import('tailwindcss').Config} */
export default {
  // 'class' strategy, keyed off <html class="dark">. This is the fix for
  // the original bug: the previous build of this app used the same
  // strategy but nothing in the app (or the rest of the site) ever added
  // that class - the site's own theme toggle only ever set a `data-theme`
  // attribute, which Tailwind's class-strategy selector never looks at.
  // src/lib/theme.js bridges the two: it mirrors data-theme onto the
  // `dark` class on <html> and keeps them in sync for the life of the page.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Brand + accent tokens pulled from the site's existing overlay
        // theme system (frontend/overlay.html's --oc-* variables) so this
        // app visually matches the rest of OrgComms instead of picking
        // its own separate palette.
        brand: {
          DEFAULT: '#00a884',
          dark: '#008f72',
        },
        gold: {
          DEFAULT: '#FFD700',
          soft: '#FFA500',
        },
      },
    },
  },
  plugins: [],
};
