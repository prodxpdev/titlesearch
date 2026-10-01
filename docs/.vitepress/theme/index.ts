import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Download from "./Download.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Download", Download);
  },
} satisfies Theme;
