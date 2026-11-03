import { betterAuth } from 'better-auth';
import { captcha } from 'better-auth/plugins';
import { env } from 'cloudflare:workers';
import { passwordHasher } from './password';

/** Better Auth on D1 (users, accounts), KV (sessions), and Turnstile (bot check on sign-up/sign-in). */
export const auth = betterAuth({
	secret: env.BETTER_AUTH_SECRET,
	database: env.DB,
	emailAndPassword: { enabled: true, minPasswordLength: 8, password: passwordHasher(env.BETTER_AUTH_SECRET) },
	secondaryStorage: {
		get: (key) => env.KV.get(key),
		// KV rejects TTLs under 60 seconds.
		set: (key, value, ttl) => env.KV.put(key, value, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
		delete: (key) => env.KV.delete(key),
		// KV has no atomic operations, so these two are best-effort. `increment` is only used by
		// Better Auth's own rate limiter, which is disabled below.
		getAndDelete: async (key) => {
			const value = await env.KV.get(key);
			if (value !== null) await env.KV.delete(key);
			return value;
		},
		increment: async (key, ttl) => {
			const next = Number((await env.KV.get(key)) ?? 0) + 1;
			await env.KV.put(key, String(next), { expirationTtl: Math.max(60, ttl) });
			return next;
		},
	},
	// Auth requests are rate limited by the AUTH_LIMITER binding in src/worker.ts.
	rateLimit: { enabled: false },
	plugins: [captcha({ provider: 'cloudflare-turnstile', secretKey: env.TURNSTILE_SECRET_KEY })],
});

export type Session = typeof auth.$Infer.Session;
