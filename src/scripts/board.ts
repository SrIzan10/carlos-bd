import { MAX_TEXT, STICKY_COLORS, type ClientMessage, type Item, type Peer, type ServerMessage } from '../board/protocol';
import { authClient } from '../lib/auth-client';

type Tool = 'select' | 'hand' | 'sticky' | 'text';
type Point = { x: number; y: number };
type Gesture =
	| { kind: 'pan'; start: Point; view: Point }
	| { kind: 'drag'; id: string; start: Point; origin: Point }
	| { kind: 'resize'; id: string; start: Point; w: number; h: number; keepAspect: boolean }
	| { kind: 'pinch'; dist: number; mid: Point };

const TEXT_COLORS = ['#1e1e1e', '#f24822', '#9747ff', '#0d99ff', '#14ae5c', '#ffa629'];

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $('#app');
const viewport = $('#viewport');
const world = $('#world');
const cursorLayer = $('#cursors');
const selectionBar = $('#selection-bar');
const toolbar = $('#toolbar');
const palette = $('#palette');
const presence = $('#presence');
const zoomLabel = $('#zoom-label');
const toastEl = $('#toast');
const fileInput = $<HTMLInputElement>('#file');

const me = app.dataset.user ? (JSON.parse(app.dataset.user) as { id: string; name: string }) : null;
const canEdit = me !== null;

const items = new Map<string, Item>();
const els = new Map<string, HTMLElement>();
const peers = new Map<string, Peer>();
const cursors = new Map<string, { el: HTMLElement; x: number; y: number }>();
const view = { x: 0, y: 0, z: 1 };
let you: Peer | null = null;
let selected: string | null = null;
let editing: string | null = null;
let tool: Tool = 'select';
let stickyColor = STICKY_COLORS[0];
let socket: WebSocket | null = null;
let fitted = false;

// crypto.randomUUID only exists in secure contexts, and the dev server is often opened over plain http on a LAN.
const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// ---------------------------------------------------------------- sync

function send(msg: ClientMessage) {
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flush() {
	clearTimeout(flushTimer);
	flushTimer = undefined;
	for (const id of pending) {
		const item = items.get(id);
		if (item) send({ t: 'upsert', item });
	}
	pending.clear();
}
/** Sends an item, batching rapid changes such as drags and typing. */
function commit(id: string, now = false) {
	pending.add(id);
	if (now) flush();
	else flushTimer ??= setTimeout(flush, 40);
}

let retry = 0;
function connect() {
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/board/ws`);
	socket = ws;
	ws.onopen = () => {
		retry = 0;
		app.classList.remove('offline');
	};
	ws.onmessage = (event) => {
		if (event.data === 'pong') return;
		receive(JSON.parse(event.data) as ServerMessage);
	};
	ws.onclose = () => {
		if (socket !== ws) return;
		socket = null;
		app.classList.add('offline');
		setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
	};
}
setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send('ping'), 30_000);

function receive(msg: ServerMessage) {
	switch (msg.t) {
		case 'init':
			for (const el of els.values()) el.remove();
			els.clear();
			items.clear();
			for (const item of msg.items) upsertLocal(item);
			you = msg.you;
			peers.clear();
			for (const p of msg.peers) peers.set(p.cid, p);
			for (const c of cursors.values()) c.el.remove();
			cursors.clear();
			renderPresence();
			if (!fitted) fit();
			fitted = true;
			break;
		case 'upsert':
			upsertLocal(msg.item);
			break;
		case 'delete':
			removeLocal(msg.id);
			break;
		case 'join':
			peers.set(msg.peer.cid, msg.peer);
			renderPresence();
			break;
		case 'leave':
			peers.delete(msg.cid);
			cursors.get(msg.cid)?.el.remove();
			cursors.delete(msg.cid);
			renderPresence();
			break;
		case 'cursor':
			moveCursor(msg.cid, msg.x, msg.y);
			break;
	}
}

function upsertLocal(incoming: Item) {
	const current = items.get(incoming.id);
	// Keep what the local user is typing; take everything else from the server.
	const item = current && editing === incoming.id ? { ...incoming, text: current.text } : incoming;
	items.set(item.id, item);
	render(item);
}

function removeLocal(id: string) {
	items.delete(id);
	els.get(id)?.remove();
	els.delete(id);
	if (editing === id) editing = null;
	if (selected === id) select(null);
}

// ---------------------------------------------------------------- rendering

function isDark(hex = '#ffffff') {
	const n = parseInt(hex.slice(1, 7).padEnd(6, 'f'), 16);
	return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 140;
}

function build(item: Item) {
	const el = document.createElement('div');
	el.className = `item ${item.type}`;
	el.dataset.id = item.id;
	el.dataset.type = item.type;
	if (item.type === 'sticky' || item.type === 'text') {
		const body = document.createElement('div');
		body.className = 'body';
		body.addEventListener('input', () => {
			const current = items.get(item.id);
			if (!current || editing !== item.id) return;
			current.text = body.innerText.replace(/\n$/, '').slice(0, MAX_TEXT);
			commit(item.id);
		});
		body.addEventListener('blur', () => editing === item.id && stopEditing());
		el.appendChild(body);
	} else if (item.type === 'image') {
		const img = document.createElement('img');
		img.src = item.src!;
		img.draggable = false;
		img.alt = '';
		el.appendChild(img);
	} else {
		const video = document.createElement('video');
		video.src = item.src!;
		video.controls = true;
		video.loop = true;
		video.playsInline = true;
		video.preload = 'metadata';
		el.appendChild(video);
	}
	if (item.type !== 'text') {
		const author = document.createElement('div');
		author.className = 'author';
		el.appendChild(author);
	}
	const handle = document.createElement('div');
	handle.className = 'handle';
	el.appendChild(handle);
	return el;
}

function render(item: Item) {
	let el = els.get(item.id);
	if (!el || el.dataset.type !== item.type) {
		el?.remove();
		el = build(item);
		els.set(item.id, el);
		world.appendChild(el);
	}
	el.style.left = `${item.x}px`;
	el.style.top = `${item.y}px`;
	el.style.width = `${item.w}px`;
	el.style.zIndex = String(Math.round(item.z));
	el.style.minHeight = item.type === 'sticky' || item.boxed ? `${item.h}px` : '';
	el.classList.toggle('selected', selected === item.id);
	if (item.type === 'sticky') {
		el.style.background = item.color ?? STICKY_COLORS[0];
		el.classList.toggle('dark', isDark(item.color));
	}
	if (item.type === 'text') {
		el.style.color = item.color ?? TEXT_COLORS[0];
		el.classList.toggle('boxed', !!item.boxed);
		el.classList.toggle('mono', item.font === 'mono');
	}
	const body = el.querySelector<HTMLElement>('.body');
	if (body && editing !== item.id && body.textContent !== (item.text ?? '')) body.textContent = item.text ?? '';
	const author = el.querySelector<HTMLElement>('.author');
	if (author) author.textContent = item.author ?? '';
	if (selected === item.id) placeSelectionBar();
}

function applyView() {
	world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
	const grid = 24 * view.z;
	viewport.style.backgroundSize = `${grid}px ${grid}px`;
	viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
	viewport.classList.toggle('far', view.z < 0.5);
	zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
	for (const c of cursors.values()) placeCursor(c);
	placeSelectionBar();
}

const toWorld = (cx: number, cy: number): Point => ({ x: (cx - view.x) / view.z, y: (cy - view.y) / view.z });
const screenCenter = () => toWorld(innerWidth / 2, innerHeight / 2);

function zoomAt(cx: number, cy: number, factor: number) {
	const z = Math.min(4, Math.max(0.1, view.z * factor));
	const p = toWorld(cx, cy);
	view.x = cx - p.x * z;
	view.y = cy - p.y * z;
	view.z = z;
	applyView();
}

/** Frames every item, never zooming in past 100%. */
function fit() {
	if (els.size === 0) {
		view.x = innerWidth / 2;
		view.y = innerHeight / 2;
		view.z = 1;
		return applyView();
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [id, el] of els) {
		const item = items.get(id)!;
		minX = Math.min(minX, item.x);
		minY = Math.min(minY, item.y);
		maxX = Math.max(maxX, item.x + el.offsetWidth);
		maxY = Math.max(maxY, item.y + el.offsetHeight);
	}
	const z = Math.max(0.1, Math.min(1, (innerWidth - 96) / (maxX - minX), (innerHeight - 220) / (maxY - minY)));
	view.z = z;
	view.x = innerWidth / 2 - ((minX + maxX) / 2) * z;
	view.y = innerHeight / 2 - 20 - ((minY + maxY) / 2) * z;
	applyView();
}

// ---------------------------------------------------------------- selection & editing

function select(id: string | null) {
	if (selected) els.get(selected)?.classList.remove('selected');
	selected = id;
	if (id) els.get(id)?.classList.add('selected');
	buildSelectionBar();
}

function buildSelectionBar() {
	const item = selected ? items.get(selected) : null;
	selectionBar.replaceChildren();
	if (!item || !canEdit) {
		selectionBar.hidden = true;
		return;
	}
	const colors = item.type === 'sticky' ? STICKY_COLORS : item.type === 'text' ? TEXT_COLORS : [];
	for (const color of colors) {
		const b = document.createElement('button');
		b.className = 'swatch';
		b.style.background = color;
		b.title = color;
		b.classList.toggle('active', (item.color ?? colors[0]) === color);
		b.onclick = () => {
			item.color = color;
			if (item.type === 'sticky') stickyColor = color;
			render(item);
			commit(item.id, true);
			buildSelectionBar();
		};
		selectionBar.appendChild(b);
	}
	if (colors.length) selectionBar.appendChild(Object.assign(document.createElement('span'), { className: 'sep' }));
	const del = document.createElement('button');
	del.className = 'icon-btn';
	del.title = 'Delete (Del)';
	del.innerHTML = ICONS.trash;
	del.onclick = () => deleteItem(item.id);
	selectionBar.appendChild(del);
	selectionBar.hidden = false;
	placeSelectionBar();
}

function placeSelectionBar() {
	const el = selected ? els.get(selected) : null;
	if (!el || selectionBar.hidden) return;
	const r = el.getBoundingClientRect();
	const bar = selectionBar.getBoundingClientRect();
	const left = Math.min(innerWidth - bar.width - 8, Math.max(8, r.left + r.width / 2 - bar.width / 2));
	const top = r.top - bar.height - 12 < 64 ? r.bottom + 12 : r.top - bar.height - 12;
	selectionBar.style.transform = `translate(${left}px, ${top}px)`;
}

function startEditing(id: string) {
	const el = els.get(id);
	const body = el?.querySelector<HTMLElement>('.body');
	if (!el || !body || !canEdit) return;
	editing = id;
	el.classList.add('editing');
	body.contentEditable = 'plaintext-only';
	if (body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
	// Focus after the pointer sequence finishes, or the browser moves focus back to the clicked element.
	setTimeout(() => {
		body.focus();
		const range = document.createRange();
		range.selectNodeContents(body);
		range.collapse(false);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	});
}

function stopEditing() {
	const id = editing;
	if (!id) return;
	editing = null;
	const el = els.get(id);
	el?.classList.remove('editing');
	const body = el?.querySelector<HTMLElement>('.body');
	if (body) body.contentEditable = 'false';
	const item = items.get(id);
	if (item?.type === 'text' && !item.text?.trim()) return deleteItem(id);
	commit(id, true);
}

function maxZ() {
	let z = 0;
	for (const item of items.values()) z = Math.max(z, item.z);
	return z;
}

function create(partial: Omit<Item, 'id' | 'z'>) {
	const item: Item = { ...partial, id: newId(), z: maxZ() + 1, author: me?.name };
	items.set(item.id, item);
	render(item);
	commit(item.id, true);
	select(item.id);
	return item;
}

function deleteItem(id: string) {
	removeLocal(id);
	send({ t: 'delete', id });
}

// ---------------------------------------------------------------- tools

function setTool(next: Tool) {
	tool = next;
	for (const b of toolbar.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('active', b.dataset.tool === next);
	viewport.dataset.tool = next;
	palette.hidden = next !== 'sticky';
}

function buildPalette() {
	for (const color of STICKY_COLORS) {
		const b = document.createElement('button');
		b.className = 'swatch';
		b.style.background = color;
		b.onclick = () => {
			stickyColor = color;
			for (const s of palette.children) s.classList.toggle('active', s === b);
			$('#sticky-chip').style.background = color;
		};
		b.classList.toggle('active', color === stickyColor);
		palette.appendChild(b);
	}
}

toolbar.addEventListener('click', (event) => {
	const button = (event.target as Element).closest<HTMLElement>('button');
	if (!button) return;
	if (button.dataset.tool) setTool(button.dataset.tool as Tool);
	if (button.id === 'upload-btn') fileInput.click();
});
fileInput.addEventListener('change', () => {
	upload([...(fileInput.files ?? [])], screenCenter());
	fileInput.value = '';
});

// ---------------------------------------------------------------- uploads (R2)

function mediaSize(file: File): Promise<[number, number]> {
	const url = URL.createObjectURL(file);
	return new Promise<[number, number]>((resolve) => {
		const done = (w: number, h: number) => {
			URL.revokeObjectURL(url);
			resolve(w && h ? [w, h] : [360, 270]);
		};
		if (file.type.startsWith('video/')) {
			const v = document.createElement('video');
			v.preload = 'metadata';
			v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight);
			v.onerror = () => done(0, 0);
			v.src = url;
		} else {
			const img = new Image();
			img.onload = () => done(img.naturalWidth, img.naturalHeight);
			img.onerror = () => done(0, 0);
			img.src = url;
		}
	});
}

async function upload(files: File[], at: Point) {
	if (!canEdit) return toast('Sign in to add photos and videos');
	let p = at;
	for (const file of files) {
		if (!/^(image|video)\//.test(file.type)) {
			toast(`${file.name} isn't an image or video`);
			continue;
		}
		toast(`Uploading ${file.name}…`, 0);
		const [res, [nw, nh]] = await Promise.all([
			fetch('/api/upload', { method: 'POST', body: file, headers: { 'content-type': file.type } }),
			mediaSize(file),
		]);
		if (!res.ok) {
			toast(`Upload failed: ${await res.text()}`);
			continue;
		}
		const { src } = (await res.json()) as { src: string };
		const w = Math.min(360, nw);
		const h = (w * nh) / nw;
		create({ type: file.type.startsWith('video/') ? 'video' : 'image', x: p.x - w / 2, y: p.y - h / 2, w, h, src });
		p = { x: p.x + 32, y: p.y + 32 };
		toast(`Added ${file.name}`);
	}
}

viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('drop', (e) => {
	e.preventDefault();
	upload([...(e.dataTransfer?.files ?? [])], toWorld(e.clientX, e.clientY));
});
document.addEventListener('paste', (e) => {
	if (editing) return;
	const files = [...(e.clipboardData?.files ?? [])];
	if (files.length) upload(files, screenCenter());
});

// ---------------------------------------------------------------- pointer input

const pointers = new Map<number, Point>();
let gesture: Gesture | null = null;
let spaceDown = false;
let lastDown = { id: '', time: 0 };
let lastCursorSent = 0;

function pinchState(): { dist: number; mid: Point } {
	const [a, b] = [...pointers.values()];
	return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

viewport.addEventListener('pointerdown', (e) => {
	pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	if (pointers.size === 2) {
		gesture = { kind: 'pinch', ...pinchState() };
		return;
	}
	if (pointers.size > 2) return;

	const target = e.target as HTMLElement;
	const itemEl = target.closest<HTMLElement>('.item');
	const id = itemEl?.dataset.id ?? null;
	if (id && id === editing) return;
	if (editing) stopEditing();

	const start = { x: e.clientX, y: e.clientY };
	const panning = tool === 'hand' || spaceDown || e.button === 1;

	if (!panning && canEdit && (tool === 'sticky' || tool === 'text')) {
		const p = toWorld(e.clientX, e.clientY);
		const item =
			tool === 'sticky'
				? create({ type: 'sticky', x: p.x - 120, y: p.y - 120, w: 240, h: 240, color: stickyColor, text: '' })
				: create({ type: 'text', x: p.x, y: p.y - 14, w: 280, h: 40, color: TEXT_COLORS[0], text: '' });
		startEditing(item.id);
		setTool('select');
		return;
	}

	if (!panning && id) {
		const item = items.get(id)!;
		select(id);
		const now = performance.now();
		const doubleTap = lastDown.id === id && now - lastDown.time < 350;
		lastDown = { id, time: now };
		if (doubleTap && (item.type === 'sticky' || item.type === 'text')) return startEditing(id);
		if (!canEdit || target.tagName === 'VIDEO') return;
		if (target.classList.contains('handle')) {
			gesture = { kind: 'resize', id, start, w: item.w, h: item.h, keepAspect: item.type === 'image' || item.type === 'video' };
		} else {
			if (item.z < maxZ()) {
				item.z = maxZ() + 1;
				render(item);
				commit(id);
			}
			gesture = { kind: 'drag', id, start, origin: { x: item.x, y: item.y } };
		}
		viewport.setPointerCapture(e.pointerId);
		return;
	}

	if (!id) select(null);
	gesture = { kind: 'pan', start, view: { x: view.x, y: view.y } };
	viewport.classList.add('panning');
	viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
	if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

	if (e.pointerType === 'mouse' && performance.now() - lastCursorSent > 50) {
		lastCursorSent = performance.now();
		const p = toWorld(e.clientX, e.clientY);
		send({ t: 'cursor', x: Math.round(p.x), y: Math.round(p.y) });
	}
	if (!gesture) return;

	if (gesture.kind === 'pinch' && pointers.size === 2) {
		const next = pinchState();
		view.x += next.mid.x - gesture.mid.x;
		view.y += next.mid.y - gesture.mid.y;
		gesture.mid = next.mid;
		if (gesture.dist > 0) zoomAt(next.mid.x, next.mid.y, next.dist / gesture.dist);
		gesture.dist = next.dist;
		return;
	}
	const dx = e.clientX - (gesture as { start: Point }).start.x;
	const dy = e.clientY - (gesture as { start: Point }).start.y;
	if (gesture.kind === 'pan') {
		view.x = gesture.view.x + dx;
		view.y = gesture.view.y + dy;
		applyView();
	} else if (gesture.kind === 'drag') {
		const item = items.get(gesture.id);
		if (!item) return;
		item.x = Math.round(gesture.origin.x + dx / view.z);
		item.y = Math.round(gesture.origin.y + dy / view.z);
		render(item);
		commit(item.id);
	} else if (gesture.kind === 'resize') {
		const item = items.get(gesture.id);
		if (!item) return;
		item.w = Math.round(Math.max(80, gesture.w + dx / view.z));
		item.h = Math.round(gesture.keepAspect ? (item.w * gesture.h) / gesture.w : Math.max(60, gesture.h + dy / view.z));
		render(item);
		commit(item.id);
	}
});

function endPointer(e: PointerEvent) {
	pointers.delete(e.pointerId);
	if (gesture && (gesture.kind === 'drag' || gesture.kind === 'resize')) commit(gesture.id, true);
	if (pointers.size === 0) gesture = null;
	else if (gesture?.kind === 'pinch') gesture = null;
	viewport.classList.remove('panning');
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

viewport.addEventListener(
	'wheel',
	(e) => {
		if (editing && (e.target as Element).closest('.editing')) return;
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
		else {
			view.x -= e.deltaX;
			view.y -= e.deltaY;
			applyView();
		}
	},
	{ passive: false },
);

$('#zoom-in').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
$('#zoom-out').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
zoomLabel.onclick = fit;
addEventListener('resize', placeSelectionBar);

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
	if (editing) {
		if (e.key === 'Escape') {
			(document.activeElement as HTMLElement | null)?.blur();
			stopEditing();
		}
		return;
	}
	if ((e.target as Element).closest('input, textarea, [contenteditable="true"]')) return;
	if (e.key === ' ') {
		spaceDown = true;
		viewport.classList.add('space');
		e.preventDefault();
	} else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && canEdit) deleteItem(selected);
	else if (e.key === 'Escape') select(null);
	else if (e.key === 'Enter' && selected) startEditing(selected);
	else if (e.ctrlKey || e.metaKey || e.altKey) return;
	else if (e.key === 'v') setTool('select');
	else if (e.key === 'h') setTool('hand');
	else if (e.key === 's' && canEdit) setTool('sticky');
	else if (e.key === 't' && canEdit) setTool('text');
	else if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
	else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
	else if (e.key === '1' && e.shiftKey) fit();
});
document.addEventListener('keyup', (e) => {
	if (e.key === ' ') {
		spaceDown = false;
		viewport.classList.remove('space');
	}
});

// ---------------------------------------------------------------- presence

function initials(name: string) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

function renderPresence() {
	const everyone = [...(you ? [you] : []), ...peers.values()];
	presence.replaceChildren();
	for (const p of everyone.slice(0, 5)) {
		const a = document.createElement('span');
		a.className = 'avatar';
		a.style.background = p.color;
		a.textContent = initials(p.name);
		a.title = p === you ? `${p.name} (you)` : p.name;
		presence.appendChild(a);
	}
	if (everyone.length > 5) {
		const more = document.createElement('span');
		more.className = 'avatar more';
		more.textContent = `+${everyone.length - 5}`;
		presence.appendChild(more);
	}
	for (const [cid, c] of cursors) {
		const peer = peers.get(cid);
		if (peer) c.el.style.setProperty('--c', peer.color);
	}
}

function placeCursor(c: { el: HTMLElement; x: number; y: number }) {
	c.el.style.transform = `translate(${c.x * view.z + view.x}px, ${c.y * view.z + view.y}px)`;
}

function moveCursor(cid: string, x: number, y: number) {
	let c = cursors.get(cid);
	if (!c) {
		const peer = peers.get(cid);
		const el = document.createElement('div');
		el.className = 'cursor';
		el.style.setProperty('--c', peer?.color ?? '#9747ff');
		el.innerHTML = `${ICONS.cursor}<span></span>`;
		el.querySelector('span')!.textContent = peer?.name ?? 'Guest';
		cursorLayer.appendChild(el);
		c = { el, x, y };
		cursors.set(cid, c);
	}
	c.x = x;
	c.y = y;
	placeCursor(c);
}

// ---------------------------------------------------------------- chrome

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, ms = 2600) {
	toastEl.textContent = message;
	toastEl.hidden = false;
	clearTimeout(toastTimer);
	if (ms) toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

$('#share').onclick = async () => {
	try {
		await navigator.clipboard.writeText(location.origin);
		toast('Link copied. Send it to everyone (except Carlos)');
	} catch {
		toast(location.origin, 6000);
	}
};

document.querySelector('#sign-out')?.addEventListener('click', async () => {
	await authClient.signOut();
	location.reload();
});

const ICONS = {
	trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
	cursor: '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5 15.5 7 9 9l-2 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>',
};

if (!canEdit) app.classList.add('readonly');
buildPalette();
setTool('select');
applyView();
connect();
