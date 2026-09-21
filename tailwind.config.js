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
        apple: {
          bg: '#181818',
          panel: '#141414',
          card: '#1F1F1F',
          subtle: '#242424',
          hover: '#2A2A2A',
          active: '#37373D',
          border: 'rgba(240, 240, 240, 0.075)',
          'border-subtle': 'rgba(240, 240, 240, 0.04)',
          'border-focus': 'rgba(129, 161, 193, 0.55)',
          blue: '#81A1C1',
          'blue-hover': '#9AB4CF',
          purple: '#B48EAD',
          pink: '#E34671',
          green: '#3FA266',
          amber: '#F1B467',
          red: '#E34671',
          cyan: '#88C0D0',
          indigo: '#8F9BB3',
          text: {
            primary: '#F0F0F0',
            secondary: 'rgba(240, 240, 240, 0.74)',
            tertiary: 'rgba(240, 240, 240, 0.60)',
            muted: 'rgba(240, 240, 240, 0.36)',
          }
        }
      },
      fontFamily: {
        sans: [
          '"SF Pro Text"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe WPC"',
          '"Segoe UI"',
          'sans-serif'
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Cascadia Code"',
          'monospace'
        ]
      },
      boxShadow: {
        'apple-sm': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'apple-md': '0 4px 12px rgba(0, 0, 0, 0.35)',
        'apple-lg': '0 10px 28px rgba(0, 0, 0, 0.45)',
        'apple-window': '0 18px 50px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(240, 240, 240, 0.075)',
        'apple-glow': '0 0 14px rgba(129, 161, 193, 0.22)',
      },
      backdropBlur: {
        'apple': '24px',
        'glass': '16px',
      }
    },
  },
  plugins: [],
}
