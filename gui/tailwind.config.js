/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        crab: {
          orange: '#ff6b35',
          dark: '#0a0a0a',
          card: '#1a1a1a',
          border: '#333',
        }
      }
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
