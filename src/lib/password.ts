import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { verifyPassword as verifyDefault } from 'better-auth/crypto';

/**
 * Password hashing sized for the Workers Free plan's 10 ms CPU budget.
 *
 * Better Auth's default scrypt (N=16384, r=16) costs ~50 ms of CPU, so sign-up and sign-in
 * would be killed on the free plan. This uses native scrypt at N=1024, r=8 (~1.5 ms; a whole sign-in measured ~5 ms). To make up
 * for the cheaper hash, the password is first keyed with BETTER_AUTH_SECRET (a pepper), so a
 * leaked D1 database alone can't be brute-forced. Rotating that secret invalidates every password.
 */
const PREFIX = 's1024$';
const PARAMS = { N: 1024, r: 8, p: 1 };

function derive(secret: string, password: string, salt: Buffer) {
	const peppered = createHmac('sha256', secret).update(password.normalize('NFKC')).digest();
	return new Promise<Buffer>((resolve, reject) =>
		scrypt(peppered, salt, 32, PARAMS, (err, key) => (err ? reject(err) : resolve(key))),
	);
}

export function passwordHasher(secret: string) {
	return {
		async hash(password: string) {
			const salt = randomBytes(16);
			return `${PREFIX}${salt.toString('hex')}$${(await derive(secret, password, salt)).toString('hex')}`;
		},
		async verify({ hash, password }: { hash: string; password: string }) {
			// Accounts created before this change use Better Auth's default format.
			if (!hash.startsWith(PREFIX)) return verifyDefault({ hash, password });
			const [saltHex, keyHex] = hash.slice(PREFIX.length).split('$');
			const expected = Buffer.from(keyHex ?? '', 'hex');
			const actual = await derive(secret, password, Buffer.from(saltHex ?? '', 'hex'));
			return expected.length === actual.length && timingSafeEqual(expected, actual);
		},
	};
}
