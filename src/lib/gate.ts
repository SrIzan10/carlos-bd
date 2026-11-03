/** Shared site password: a signed cookie proves the visitor typed SITE_PASSWORD. */

export const GATE_COOKIE = 'card_pass';
export const GATE_PATH = '/unlock';

const encoder = new TextEncoder();

async function hmac(secret: string, message: string) {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Constant-time comparison of equal-length byte arrays. */
function same(a: Uint8Array, b: Uint8Array) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Changes whenever the password changes, which signs everyone out of the gate. */
export async function gateToken(env: Env) {
	return hex(await hmac(env.AUTH_SECRET, `site-password:${env.SITE_PASSWORD}`));
}

export async function passwordMatches(env: Env, attempt: string) {
	if (!env.SITE_PASSWORD) return false;
	// Compare fixed-length digests so the comparison takes the same time for any input.
	const [a, b] = await Promise.all([hmac(env.AUTH_SECRET, attempt), hmac(env.AUTH_SECRET, env.SITE_PASSWORD)]);
	return same(a, b);
}

export async function hasPass(request: Request, env: Env) {
	if (!env.SITE_PASSWORD) return false;
	const cookie = request.headers.get('cookie') ?? '';
	const value = cookie.match(new RegExp(`(?:^|;\\s*)${GATE_COOKIE}=([0-9a-f]{64})`))?.[1];
	if (!value) return false;
	return same(encoder.encode(value), encoder.encode(await gateToken(env)));
}
