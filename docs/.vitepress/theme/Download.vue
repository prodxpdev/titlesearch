<script setup lang="ts">
// The download button: picks the installer for this visitor's platform and
// links to GitHub's "latest release" URL for it. Installer names are stable
// across versions (see .github/workflows/release.yml), so these links always
// give the newest release. No requests are made to find them.
import { computed, onMounted, ref } from "vue";
import pkg from "../../../apps/cli/package.json";

const REPO = "https://github.com/prodxpdev/titlesearch";
const latest = (file: string) => `${REPO}/releases/latest/download/${file}`;

interface Option {
  id: string;
  label: string;
  file: string;
  note: string;
}

const OPTIONS: Option[] = [
  {
    id: "mac-arm",
    label: "macOS (Apple silicon)",
    file: "Titlesearch-macOS-AppleSilicon.dmg",
    note: "M1 and newer",
  },
  {
    id: "mac-intel",
    label: "macOS (Intel)",
    file: "Titlesearch-macOS-Intel.dmg",
    note: "Intel Macs",
  },
  {
    id: "win",
    label: "Windows",
    file: "Titlesearch-Windows-x64-setup.exe",
    note: "64-bit installer",
  },
  {
    id: "linux-appimage",
    label: "Linux (AppImage)",
    file: "Titlesearch-Linux-x64.AppImage",
    note: "x64, any distribution",
  },
  {
    id: "linux-deb",
    label: "Linux (.deb)",
    file: "Titlesearch-Linux-x64.deb",
    note: "Debian and Ubuntu, x64",
  },
  {
    id: "linux-arm",
    label: "Linux (arm64 .deb)",
    file: "Titlesearch-Linux-arm64.deb",
    note: "Debian and Ubuntu, arm64",
  },
];

const detected = ref<string>("mac-arm");
const known = ref(false);

onMounted(async () => {
  const ua = navigator.userAgent;
  const uaData = (
    navigator as {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }>;
      };
    }
  ).userAgentData;
  const platform = uaData?.platform ?? ua;
  if (/Win/i.test(platform)) detected.value = "win";
  else if (/Linux|X11/i.test(platform) && !/Android/i.test(ua)) detected.value = "linux-appimage";
  else if (/Mac/i.test(platform)) {
    // Chromium browsers report the CPU architecture; others say "Intel" on every Mac.
    let arch: string | undefined;
    try {
      arch = (await uaData?.getHighEntropyValues?.(["architecture"]))?.architecture;
    } catch {
      arch = undefined;
    }
    detected.value = arch === "x86" ? "mac-intel" : "mac-arm";
  } else return;
  known.value = true;
});

const primary = computed(
  () => OPTIONS.find((o) => o.id === detected.value) ?? (OPTIONS[0] as Option),
);
const others = computed(() => OPTIONS.filter((o) => o.id !== primary.value.id));
</script>

<template>
  <div class="ts-download">
    <a class="ts-primary" :href="latest(primary.file)">
      <span class="ts-primary-label">Download for {{ primary.label }}</span>
      <span class="ts-primary-note">Version {{ pkg.version }} · {{ primary.note }}</span>
    </a>
    <p class="ts-hint" v-if="!known">Not your platform? Choose below.</p>
    <ul class="ts-others">
      <li v-for="o in others" :key="o.id">
        <a :href="latest(o.file)">{{ o.label }}</a>
        <span>{{ o.note }}</span>
      </li>
    </ul>
    <p class="ts-more">
      Command-line binaries, checksums, and SBOMs are on the
      <a :href="`${REPO}/releases/latest`">release page</a>. Or run it with Node:
      <code>npx -y titlesearch</code>.
    </p>
  </div>
</template>

<style scoped>
.ts-download {
  max-width: 640px;
}
.ts-primary {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 26px;
  border-radius: 12px;
  background: var(--vp-c-brand-3);
  color: #fff !important;
  text-decoration: none !important;
  box-shadow: 0 6px 20px rgb(22 35 59 / 0.18);
  transition: transform 0.15s, box-shadow 0.15s;
}
.ts-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgb(22 35 59 / 0.24);
}
.ts-primary-label {
  font-size: 18px;
  font-weight: 700;
}
.ts-primary-note {
  font-size: 13px;
  opacity: 0.85;
}
.ts-hint {
  margin: 10px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.ts-others {
  list-style: none;
  padding: 0;
  margin: 18px 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px 18px;
}
.ts-others li {
  margin: 0;
  display: flex;
  flex-direction: column;
  font-size: 14px;
}
.ts-others span {
  color: var(--vp-c-text-2);
  font-size: 12px;
}
.ts-more {
  font-size: 14px;
  color: var(--vp-c-text-2);
}
@media (prefers-reduced-motion: reduce) {
  .ts-primary {
    transition: none;
  }
}
</style>
