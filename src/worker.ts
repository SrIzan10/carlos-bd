import { handle } from '@astrojs/cloudflare/handler';
import { getUser } from './lib/auth';
import { GATE_PATH, hasPass } from './lib/gate';
import type { Identity } from './board/room';
import { BOARD_NAME } from './board/protocol';

export { BoardRoom } from './board/room';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Everything except the unlock page sits behind the shared site password.
		// (Built assets under /_astro are served by Workers Static Assets before this runs.)
		if (url.pathname !== GATE_PATH && !(await hasPass(request, env))) {
			if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return new Response('Locked', { status: 401 });
			const next = url.pathname + url.search;
			return Response.redirect(`${url.origin}${GATE_PATH}${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, 303);
		}

		// CSRF: state-changing requests and the board socket must come from this site.
		const origin = request.headers.get('Origin');
		const writes = request.method !== 'GET' && request.method !== 'HEAD';
		if ((writes || url.pathname === '/api/board/ws') && origin && new URL(origin).host !== url.host) {
			return new Response('Bad origin', { status: 403 });
		}

		const limited = (url.pathname.startsWith('/api/auth/') || url.pathname === GATE_PATH) && request.method === 'POST';
		if (limited) {
			const key = request.headers.get('cf-connecting-ip') ?? 'local';
			const { success } = await env.AUTH_LIMITER.limit({ key });
			if (!success) return new Response('Too many attempts, try again in a minute.', { status: 429 });
		}

		// WebSockets go straight to the Durable Object, outside Astro's rendering pipeline.
		if (url.pathname === '/api/board/ws') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

			const user = await getUser(request);
			const identity: Identity = user ? { userId: user.id, name: user.name } : { userId: null, name: 'Guest' };
			const forwarded = new Request(request);
			forwarded.headers.set('x-board-identity', JSON.stringify(identity));
			return env.BOARD.getByName(BOARD_NAME).fetch(forwarded);
		}

		return handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
