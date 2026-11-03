import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/** Stays under the Workers request body limit on every plan. */
const MAX_BYTES = 95 * 1024 * 1024;
const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
};

/** Streams the request body straight into R2. */
export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) return new Response('Sign in to upload', { status: 401 });

	const type = request.headers.get('content-type') ?? '';
	const ext = EXT[type];
	if (!ext) return new Response('Only images and videos', { status: 415 });
	const size = Number(request.headers.get('content-length'));
	if (!size || size > MAX_BYTES) return new Response('File too large (max 95 MB)', { status: 413 });

	const key = `${crypto.randomUUID()}.${ext}`;
	await env.MEDIA.put(key, request.body, {
		httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
		customMetadata: { uploadedBy: locals.user.id },
	});
	return Response.json({ src: `/api/media/${key}` });
};
