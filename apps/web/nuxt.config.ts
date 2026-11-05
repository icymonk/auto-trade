import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  app: {
    head: {
      htmlAttrs: { lang: 'ko' },
      title: 'auto-trade',
    },
  },
  modules: ['shadcn-nuxt'],
  css: ['~/assets/css/tailwind.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  shadcn: {
    prefix: '',
    componentDir: '@/components/ui',
  },
  // Read at runtime from NUXT_DB_PATH / NUXT_KILL_SWITCH_PATH / NUXT_BACKTEST_DB_PATH; same files as the bot.
  runtimeConfig: {
    dbPath: '../../data/bot.sqlite3',
    killSwitchPath: '../../data/KILL',
    backtestDbPath: '../../data/backtest.sqlite3',
    dashboardPassword: '',
  },
})
