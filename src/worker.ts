import { handle } from '@astrojs/cloudflare/handler';
import { auth } from './lib/auth';
import { GATE_PATH, hasPass } from './lib/gate';
import type { Identity } from './board/room';

export { BoardRoom } from './board/room';

/** The single board this card lives on. */
const BOARD_NAME = 'carlos-bday';

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

		const limited = (url.pathname.startsWith('/api/auth/') || url.pathname === GATE_PATH) && request.method === 'POST';
		if (limited) {
			const key = request.headers.get('cf-connecting-ip') ?? 'local';
			const { success } = await env.AUTH_LIMITER.limit({ key });
			if (!success) return new Response('Too many attempts, try again in a minute.', { status: 429 });
		}

		// WebSockets go straight to the Durable Object, outside Astro's rendering pipeline.
		if (url.pathname === '/api/board/ws') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
			const origin = request.headers.get('Origin');
			if (origin && new URL(origin).host !== url.host) return new Response('Bad origin', { status: 403 });

			const session = await auth.api.getSession({ headers: request.headers });
			const identity: Identity = session
				? { userId: session.user.id, name: session.user.name }
				: { userId: null, name: 'Guest' };
			const forwarded = new Request(request);
			forwarded.headers.set('x-board-identity', JSON.stringify(identity));
			return env.BOARD.getByName(BOARD_NAME).fetch(forwarded);
		}

		return handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
