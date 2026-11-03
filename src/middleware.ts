import { defineMiddleware } from 'astro:middleware';
import { getUser } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;
	if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/media/')) return next();
	context.locals.user = await getUser(context.request);
	return next();
});
