/** Wire format shared by the BoardRoom Durable Object and the browser client. */

export type ItemType = 'sticky' | 'text' | 'image' | 'video';

export interface Item {
	id: string;
	type: ItemType;
	x: number;
	y: number;
	w: number;
	h: number;
	z: number;
	/** Sticky background or text color. */
	color?: string;
	text?: string;
	font?: 'sans' | 'mono';
	/** Draws a white card around a text item. */
	boxed?: boolean;
	/** `/api/media/<key>` for images and videos. */
	src?: string;
	author?: string;
	authorId?: string;
	updatedAt?: number;
}

export interface Peer {
	cid: string;
	name: string;
	color: string;
	canEdit: boolean;
}

export type ClientMessage =
	| { t: 'upsert'; item: Item }
	| { t: 'delete'; id: string }
	| { t: 'cursor'; x: number; y: number };

export type ServerMessage =
	| { t: 'init'; items: Item[]; you: Peer; peers: Peer[] }
	| { t: 'upsert'; item: Item }
	| { t: 'delete'; id: string }
	| { t: 'join'; peer: Peer }
	| { t: 'leave'; cid: string }
	| { t: 'cursor'; cid: string; x: number; y: number };

export const STICKY_COLORS = ['#fff3a3', '#ffc7c2', '#c2e5ff', '#cdf4d3', '#e4ccff', '#ffd8a8', '#444444'];
export const MAX_TEXT = 4000;
