// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: cloudflare(),
	// Better Auth keeps its sessions in KV; Astro sessions are unused.
	session: false,
	// The dev toolbar sits on top of the board's own toolbar.
	devToolbar: { enabled: false },
	// Inter, the typeface on cloudflare.com, self-hosted by Astro at build time.
	fonts: [
		{
			name: 'Inter',
			cssVariable: '--font-inter',
			provider: fontProviders.fontsource(),
			weights: [400, 500, 600],
			styles: ['normal'],
			subsets: ['latin', 'latin-ext'],
			fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
		},
	],
});
