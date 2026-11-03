import { env } from 'cloudflare:workers';
import { hashPassword, needsRehash, verifyPassword } from './password';

/**
 * Hand-rolled auth: users in D1, sessions in KV, Turnstile on sign-up and sign-in.
 * Requests are rate limited by the AUTH_LIMITER binding in src/worker.ts.
 */

export interface User {
	id: string;
	name: string;
	email: string;
}

const COOKIE = 'sid';
const SESSION_TTL = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** KV stores a hash of the token, so listing the namespace never reveals a usable cookie. */
async function sessionKey(token: string) {
	return `session:${hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)))}`;
}

function readToken(request: Request) {
	return request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`))?.[1] ?? null;
}

function cookie(request: Request, value: string, maxAge: number) {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function getUser(request: Request): Promise<User | null> {
	const token = readToken(request);
	if (!token) return null;
	return env.KV.get<User>(await sessionKey(token), 'json');
}

async function startSession(request: Request, user: User) {
	const token = hex(crypto.getRandomValues(new Uint8Array(32)));
	await env.KV.put(await sessionKey(token), JSON.stringify(user), { expirationTtl: SESSION_TTL });
	return Response.json({ user }, { headers: { 'set-cookie': cookie(request, token, SESSION_TTL) } });
}

/** Verifies a Turnstile token with Siteverify. */
export async function turnstileOk(request: Request, token: unknown) {
	if (typeof token !== 'string' || !token) return false;
	const body = new FormData();
	body.set('secret', env.TURNSTILE_SECRET_KEY);
	body.set('response', token);
	const ip = request.headers.get('cf-connecting-ip');
	if (ip) body.set('remoteip', ip);
	const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
	return res.ok && ((await res.json()) as { success: boolean }).success;
}

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

interface Row {
	id: string;
	name: string;
	email: string;
	password_hash: string;
}

/** Handles POST /api/auth/{sign-up,sign-in,sign-out}. */
export async function handleAuth(request: Request, action: string): Promise<Response> {
	if (request.method !== 'POST') return fail('Method not allowed', 405);

	if (action === 'sign-out') {
		const token = readToken(request);
		if (token) await env.KV.delete(await sessionKey(token));
		return new Response(null, { status: 204, headers: { 'set-cookie': cookie(request, '', 0) } });
	}
	if (action !== 'sign-up' && action !== 'sign-in') return fail('Not found', 404);

	const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!input) return fail('Expected JSON');
	const email = String(input.email ?? '').trim().toLowerCase();
	const password = String(input.password ?? '');
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail('Enter a valid email.');
	if (password.length < 8 || password.length > 256) return fail('Passwords are 8 to 256 characters.');
	if (!(await turnstileOk(request, input.turnstile))) return fail('Turnstile check failed, try again.', 403);

	if (action === 'sign-up') {
		const name = String(input.name ?? '').trim();
		if (!name || name.length > 40) return fail('Pick a name up to 40 characters.');
		const user: User = { id: crypto.randomUUID(), name, email };
		const { meta } = await env.DB.prepare(
			'INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
		)
			.bind(user.id, name, email, await hashPassword(password), Date.now())
			.run();
		if (meta.changes === 0) return fail('That email already has an account. Sign in instead.', 409);
		return startSession(request, user);
	}

	const row = await env.DB.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').bind(email).first<Row>();
	// Hash anyway for unknown emails, so response time doesn't reveal which emails exist.
	const ok = await verifyPassword(row?.password_hash ?? null, password);
	if (!row || !ok) return fail('Wrong email or password.', 401);
	if (needsRehash(row.password_hash)) {
		await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), row.id).run();
	}
	return startSession(request, { id: row.id, name: row.name, email: row.email });
}
