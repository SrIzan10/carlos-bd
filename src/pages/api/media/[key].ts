import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/** Serves R2 objects with range requests (video seeking) and conditional GETs. */
export const GET: APIRoute = async ({ params, request }) => {
	const object = await env.MEDIA.get(params.key!, { range: request.headers, onlyIf: request.headers });
	if (!object) return new Response('Not found', { status: 404 });

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('accept-ranges', 'bytes');

	if (!('body' in object)) return new Response(null, { status: 304, headers });

	const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
	if (range && request.headers.has('range')) {
		const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
		const length = range.suffix ?? range.length ?? object.size - offset;
		headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
		headers.set('content-length', String(length));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set('content-length', String(object.size));
	return new Response(object.body, { headers });
};
