// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: cloudflare(),
	// Better Auth keeps its sessions in KV; Astro sessions are unused.
	session: false,
	// The dev toolbar sits on top of the board's own toolbar.
	devToolbar: { enabled: false },
});
