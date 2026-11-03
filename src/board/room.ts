import { DurableObject } from 'cloudflare:workers';
import { MAX_TEXT, type ClientMessage, type Item, type Peer, type ServerMessage } from './protocol';

const TYPES = new Set(['sticky', 'text', 'image', 'video']);
const CURSOR_COLORS = ['#9747ff', '#f24822', '#0fa958', '#0d99ff', '#ff24bd', '#ffa629', '#14ae5c'];

const SEED: Item[] = [
	{
		id: 'title',
		type: 'text',
		x: 0,
		y: 0,
		w: 368,
		h: 164,
		z: 1,
		text: 'Happy Birthday Carlos!!!',
		color: '#f24822',
		font: 'mono',
		boxed: true,
	},
];

/** Who opened a socket, set by the Worker after it checks the session cookie. */
export interface Identity {
	userId: string | null;
	name: string;
}

/**
 * One birthday board. Items live in this object's SQLite storage; every connected browser
 * holds a hibernatable WebSocket, so an idle board costs nothing.
 */
export class BoardRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
			const { n } = ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM items').one();
			if (n === 0) for (const item of SEED) this.save(item);
		});
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async fetch(request: Request): Promise<Response> {
		const identity = JSON.parse(request.headers.get('x-board-identity') ?? 'null') as Identity | null;
		if (!identity) return new Response('Missing identity', { status: 400 });

		const { 0: client, 1: server } = new WebSocketPair();
		const sockets = this.ctx.getWebSockets();
		const you: Peer = {
			cid: crypto.randomUUID(),
			name: identity.name,
			color: CURSOR_COLORS[sockets.length % CURSOR_COLORS.length],
			canEdit: identity.userId !== null,
		};
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ ...you, userId: identity.userId });

		const peers = sockets.map((ws) => this.peer(ws)).filter((p): p is Peer => p !== null);
		this.send(server, { t: 'init', items: this.items(), you, peers });
		this.broadcast({ t: 'join', peer: you }, server);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		if (typeof raw !== 'string' || raw.length > 64_000) return;
		const me = ws.deserializeAttachment() as (Peer & { userId: string | null }) | null;
		if (!me) return;
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.t === 'cursor') {
			if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) this.broadcast({ t: 'cursor', cid: me.cid, x: msg.x, y: msg.y }, ws);
			return;
		}
		if (!me.canEdit) return;

		if (msg.t === 'delete' && typeof msg.id === 'string') {
			this.ctx.storage.sql.exec('DELETE FROM items WHERE id = ?', msg.id);
			this.broadcast({ t: 'delete', id: msg.id }, ws);
			return;
		}
		if (msg.t === 'upsert') {
			const item = this.clean(msg.item);
			if (!item) return;
			// Authorship is set once, by the server, from the verified session.
			const existing = this.item(item.id);
			item.author = existing ? existing.author : me.name;
			item.authorId = existing ? existing.authorId : (me.userId ?? undefined);
			item.updatedAt = Date.now();
			this.save(item);
			this.broadcast({ t: 'upsert', item }, ws);
		}
	}

	async webSocketClose(ws: WebSocket) {
		const me = this.peer(ws);
		if (me) this.broadcast({ t: 'leave', cid: me.cid }, ws);
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}

	private clean(input: unknown): Item | null {
		if (!input || typeof input !== 'object') return null;
		const i = input as Record<string, unknown>;
		if (typeof i.id !== 'string' || i.id.length > 64 || !TYPES.has(i.type as string)) return null;
		const num = (v: unknown, min: number, max: number) =>
			typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
		const x = num(i.x, -1e6, 1e6), y = num(i.y, -1e6, 1e6);
		const w = num(i.w, 20, 4000), h = num(i.h, 20, 4000), z = num(i.z, 0, 1e9);
		if (x === null || y === null || w === null || h === null || z === null) return null;
		const item: Item = { id: i.id, type: i.type as Item['type'], x, y, w, h, z };
		if (typeof i.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(i.color)) item.color = i.color;
		if (typeof i.text === 'string') item.text = i.text.slice(0, MAX_TEXT);
		if (i.font === 'mono' || i.font === 'sans') item.font = i.font;
		if (i.boxed === true) item.boxed = true;
		if (item.type === 'image' || item.type === 'video') {
			if (typeof i.src !== 'string' || !/^\/api\/media\/[\w.-]+$/.test(i.src)) return null;
			item.src = i.src;
		}
		return item;
	}

	private items(): Item[] {
		return this.ctx.storage.sql
			.exec<{ data: string }>('SELECT data FROM items')
			.toArray()
			.map((r) => JSON.parse(r.data));
	}

	private item(id: string): Item | null {
		const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM items WHERE id = ?', id).toArray()[0];
		return row ? JSON.parse(row.data) : null;
	}

	private save(item: Item) {
		this.ctx.storage.sql.exec(
			'INSERT INTO items (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
			item.id,
			JSON.stringify(item),
		);
	}

	private peer(ws: WebSocket): Peer | null {
		const a = ws.deserializeAttachment() as (Peer & { userId: string | null }) | null;
		return a ? { cid: a.cid, name: a.name, color: a.color, canEdit: a.canEdit } : null;
	}

	private send(ws: WebSocket, msg: ServerMessage) {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			// Socket already closing.
		}
	}

	private broadcast(msg: ServerMessage, except?: WebSocket) {
		const data = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) continue;
			try {
				ws.send(data);
			} catch {
				// Socket already closing.
			}
		}
	}
}
