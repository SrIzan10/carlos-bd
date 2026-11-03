import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { env } from 'cloudflare:workers';

/**
 * Password hashing sized for the Workers Free plan's 10 ms CPU budget.
 *
 * Native scrypt at N=1024, r=8 costs ~1.5 ms (a whole sign-in measured ~5 ms). To make up for
 * the cheap hash, the password is first keyed with AUTH_SECRET (a pepper), so a leaked D1
 * database alone can't be brute-forced. Rotating that secret invalidates every password.
 */
const PREFIX = 's1024$';
const PARAMS = { N: 1024, r: 8, p: 1 };

const run = (password: string | Buffer, salt: string | Buffer, length: number, params: typeof PARAMS) =>
	new Promise<Buffer>((resolve, reject) =>
		scrypt(password, salt, length, { ...params, maxmem: 256 * params.N * params.r }, (err, key) =>
			err ? reject(err) : resolve(key),
		),
	);

const derive = (password: string, salt: Buffer) =>
	run(createHmac('sha256', env.AUTH_SECRET).update(password.normalize('NFKC')).digest(), salt, 32, PARAMS);

const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export async function hashPassword(password: string) {
	const salt = randomBytes(16);
	return `${PREFIX}${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}

/** `hash` is null for unknown users; a dummy hash still runs so timing matches. */
export async function verifyPassword(hash: string | null, password: string) {
	if (hash?.startsWith(PREFIX)) {
		const [saltHex, keyHex] = hash.slice(PREFIX.length).split('$');
		return equal(Buffer.from(keyHex ?? '', 'hex'), await derive(password, Buffer.from(saltHex ?? '', 'hex')));
	}
	if (hash?.includes(':')) {
		// Accounts imported from Better Auth: unpeppered scrypt N=16384, r=16, salted with the hex string.
		// Slow (~50 ms), but only once per account, since sign-in rehashes it.
		const [salt, key] = hash.split(':');
		return equal(Buffer.from(key ?? '', 'hex'), await run(password.normalize('NFKC'), salt ?? '', 64, { N: 16384, r: 16, p: 1 }));
	}
	await derive(password, Buffer.alloc(16));
	return false;
}

export const needsRehash = (hash: string) => !hash.startsWith(PREFIX);
