import './assets/main.css'
import { createApp } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { registerSiemensIcons } from './icons'

// Vor dem ersten Rendern, sonst fragte Iconify die Icons im Netz an
registerSiemensIcons()

createApp(App).use(ui).mount('#app')
