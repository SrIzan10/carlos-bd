import type { APIRoute } from 'astro';
import { handleAuth } from '../../../lib/auth';

export const ALL: APIRoute = ({ request, params }) => handleAuth(request, params.action!);
