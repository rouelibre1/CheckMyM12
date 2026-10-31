/*
 * CheckMyM12
 *
 * Lists Panoramax pictures that carry a picture-level semantic tag (default: osm|traffic_sign=FR:M12)
 * but no annotation (zone inside the picture) carrying that same tag, restricted to a French commune.
 *
 * How it works:
 *   1. The commune contour comes from geo.api.gouv.fr.
 *   2. Panoramax `/api/search` is queried with the commune bounding box and a CQL2 semantic filter.
 *      This filter matches tags set on the picture AND tags set on annotations, so results are
 *      filtered client-side: the tag must be in `properties.semantics` (picture level) and in none
 *      of `properties.annotations[].semantics`.
 *   3. `/api/search` has no pagination: when a request returns `limit` results, the bounding box is
 *      split into 4 and each quarter is queried again.
 *   4. Pictures outside the commune contour (but inside its bounding box) are discarded.
 */
(() => {
	"use strict";

	const GEO_API = "https://geo.api.gouv.fr";
	const SEARCH_LIMIT = 1000;
	const MAX_SPLIT_DEPTH = 7;
	// Some instances time out (HTTP 500 after 30 s) on semantic searches over dense, large areas:
	// the commune is queried as a grid of small cells, and a failing cell is split again.
	const INITIAL_CELL_SIZE_DEG = 0.03;
	const MAX_ERROR_SPLIT_DEPTH = 2;
	// Give up when areas still fail at the finest split level and nothing has succeeded (server down, not just slow)
	const MAX_FAILED_AREAS_WITHOUT_SUCCESS = 4;
	const MAX_PARALLEL_REQUESTS = 4;
	const DONE_STORAGE_KEY = "checkmym12:done";

	// ---------------------------------------------------------------------------------------------
	// DOM
	// ---------------------------------------------------------------------------------------------
	const $ = id => document.getElementById(id);
	const form = $("search-form");
	const communeInput = $("commune-input");
	const communeSuggestions = $("commune-suggestions");
	const communeSelected = $("commune-selected");
	const sourceSelect = $("source-select");
	const sourceCustom = $("source-custom");
	const tagKeyInput = $("tag-key");
	const tagValuesInput = $("tag-values");
	const searchBtn = $("search-btn");
	const cancelBtn = $("cancel-btn");
	const statusEl = $("status");
	const resultsEl = $("results");
	const countersEl = $("counters");
	const hideDoneInput = $("hide-done");
	const recheckAllBtn = $("recheck-all-btn");
	const exportBtn = $("export-btn");
	const taskList = $("task-list");

	// ---------------------------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------------------------
	let selectedCommune = null; // { nom, code, codesPostaux, departement, contour }
	let tasks = [];
	let currentSearch = null; // AbortController of the running search
	let lastSearchTag = null; // { key, values } used for the displayed results

	const doneMap = loadDoneMap();

	function loadDoneMap() {
		try {
			return JSON.parse(localStorage.getItem(DONE_STORAGE_KEY)) || {};
		}
		catch {
			return {};
		}
	}

	function saveDoneMap() {
		try {
			localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(doneMap));
		}
		catch {
			// Storage unavailable (private browsing…): state is kept for the session only
		}
	}

	function isDone(id) {
		return Object.prototype.hasOwnProperty.call(doneMap, id);
	}

	function setDone(id, done) {
		if(done) { doneMap[id] = new Date().toISOString(); }
		else { delete doneMap[id]; }
		saveDoneMap();
	}

	// ---------------------------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------------------------
	function setStatus(message, level = "") {
		statusEl.textContent = message;
		statusEl.className = level;
	}

	async function fetchJson(url, signal) {
		const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
		if(!res.ok) {
			let detail = "";
			try { detail = (await res.json()).message || ""; }
			catch { /* not JSON */ }
			const err = new Error(`HTTP ${res.status}${detail ? ` – ${detail}` : ""} (${url})`);
			err.status = res.status;
			throw err;
		}
		return res.json();
	}

	function debounce(fn, delay) {
		let timer;
		return (...args) => {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), delay);
		};
	}

	function getSourceApi() {
		const value = sourceSelect.value === "custom" ? sourceCustom.value.trim() : sourceSelect.value;
		return normalizeApiBase(value);
	}

	/** Returns an API base URL ending with /api (no trailing slash) */
	function normalizeApiBase(url) {
		if(!url) { return ""; }
		const clean = url.trim().replace(/\/+$/, "");
		return /\/api$/.test(clean) ? clean : `${clean}/api`;
	}

	function viewerBaseFromApi(apiBase) {
		return apiBase.replace(/\/api$/, "");
	}

	function getTagFromForm() {
		const key = tagKeyInput.value.trim();
		const values = tagValuesInput.value.split(",").map(v => v.trim()).filter(Boolean);
		return { key, values };
	}

	function cqlQuote(str) {
		return `'${str.replace(/'/g, "''")}'`;
	}

	/** Builds the CQL2 filter, e.g. "semantics.osm|traffic_sign"='FR:M12' */
	function buildCqlFilter({ key, values }) {
		const attr = `"semantics.${key}"`;
		if(values.length === 1) { return `${attr}=${cqlQuote(values[0])}`; }
		return `${attr} IN (${values.map(cqlQuote).join(", ")})`;
	}

	function tagMatcher({ key, values }) {
		return tag => tag && tag.key === key && values.includes(tag.value);
	}

	/**
	 * Picture needs a zone if the tag is set at picture level and no annotation carries it.
	 * @returns {"todo"|"has-zone"|"no-tag"}
	 */
	function zoneStatus(feature, tag) {
		const match = tagMatcher(tag);
		const props = feature.properties || {};
		const annotated = (props.annotations || []).some(a => (a.semantics || []).some(match));
		if(annotated) { return "has-zone"; }
		const pictureTagged = (props.semantics || []).some(match);
		return pictureTagged ? "todo" : "no-tag";
	}

	// ---------------------------------------------------------------------------------------------
	// Geometry
	// ---------------------------------------------------------------------------------------------
	function geometryBbox(geom) {
		let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
		const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
		for(const polygon of polygons) {
			for(const [x, y] of polygon[0]) {
				if(x < minx) { minx = x; }
				if(y < miny) { miny = y; }
				if(x > maxx) { maxx = x; }
				if(y > maxy) { maxy = y; }
			}
		}
		return [minx, miny, maxx, maxy];
	}

	function pointInRing([x, y], ring) {
		let inside = false;
		for(let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if(((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
				inside = !inside;
			}
		}
		return inside;
	}

	function pointInGeometry(point, geom) {
		const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
		return polygons.some(([outer, ...holes]) => pointInRing(point, outer) && !holes.some(h => pointInRing(point, h)));
	}

	/** Liang–Barsky: does segment [a, b] cross rectangle [minx, miny, maxx, maxy]? */
	function segmentIntersectsRect([x1, y1], [x2, y2], [minx, miny, maxx, maxy]) {
		const dx = x2 - x1, dy = y2 - y1;
		const p = [-dx, dx, -dy, dy];
		const q = [x1 - minx, maxx - x1, y1 - miny, maxy - y1];
		let t0 = 0, t1 = 1;
		for(let i = 0; i < 4; i++) {
			if(p[i] === 0) {
				if(q[i] < 0) { return false; }
			}
			else {
				const t = q[i] / p[i];
				if(p[i] < 0) { t0 = Math.max(t0, t); }
				else { t1 = Math.min(t1, t); }
				if(t0 > t1) { return false; }
			}
		}
		return true;
	}

	function rectIntersectsGeometry(rect, geom) {
		const [minx, miny, maxx, maxy] = rect;
		if(pointInGeometry([(minx + maxx) / 2, (miny + maxy) / 2], geom)) { return true; }
		const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
		return polygons.some(rings => rings.some(ring =>
			ring.some((pt, i) => i > 0 && segmentIntersectsRect(ring[i - 1], pt, rect))
		));
	}

	/** Splits bbox in a grid of cells of at most `size` degrees, keeping only cells touching the geometry */
	function gridCells([minx, miny, maxx, maxy], size, geom) {
		const nx = Math.max(1, Math.ceil((maxx - minx) / size));
		const ny = Math.max(1, Math.ceil((maxy - miny) / size));
		const w = (maxx - minx) / nx;
		const h = (maxy - miny) / ny;
		const cells = [];
		for(let i = 0; i < nx; i++) {
			for(let j = 0; j < ny; j++) {
				const cell = [
					minx + i * w,
					miny + j * h,
					i === nx - 1 ? maxx : minx + (i + 1) * w,
					j === ny - 1 ? maxy : miny + (j + 1) * h,
				];
				if(rectIntersectsGeometry(cell, geom)) { cells.push(cell); }
			}
		}
		return cells;
	}

	function splitBbox([minx, miny, maxx, maxy]) {
		const mx = (minx + maxx) / 2;
		const my = (miny + maxy) / 2;
		return [
			[minx, miny, mx, my],
			[mx, miny, maxx, my],
			[minx, my, mx, maxy],
			[mx, my, maxx, maxy],
		];
	}

	// ---------------------------------------------------------------------------------------------
	// Commune search (geo.api.gouv.fr)
	// ---------------------------------------------------------------------------------------------
	const COMMUNE_FIELDS = "nom,code,codesPostaux,departement";

	async function searchCommunes(query) {
		const q = query.trim();
		if(q.length < 2) { return []; }
		if(/^\d[\dAB]\d{3}$/i.test(q)) {
			// 5 chars: either a postal code or an INSEE code
			const [byPostal, byInsee] = await Promise.all([
				fetchJson(`${GEO_API}/communes?codePostal=${encodeURIComponent(q)}&fields=${COMMUNE_FIELDS}`).catch(() => []),
				fetchJson(`${GEO_API}/communes?code=${encodeURIComponent(q.toUpperCase())}&fields=${COMMUNE_FIELDS}`).catch(() => []),
			]);
			const seen = new Set();
			return [...byInsee, ...byPostal].filter(c => !seen.has(c.code) && seen.add(c.code));
		}
		return fetchJson(`${GEO_API}/communes?nom=${encodeURIComponent(q)}&fields=${COMMUNE_FIELDS}&boost=population&limit=10`);
	}

	async function loadCommune(code) {
		return fetchJson(`${GEO_API}/communes/${encodeURIComponent(code)}?fields=${COMMUNE_FIELDS},contour`);
	}

	function communeLabel(c) {
		const dep = c.departement ? `${c.departement.nom} (${c.departement.code})` : "";
		return `${c.nom}${dep ? ` – ${dep}` : ""}`;
	}

	let suggestionItems = [];
	let activeSuggestion = -1;

	function renderSuggestions(communes) {
		suggestionItems = communes;
		activeSuggestion = -1;
		communeSuggestions.replaceChildren();
		if(!communes.length) {
			communeSuggestions.hidden = true;
			return;
		}
		communes.forEach((c, i) => {
			const li = document.createElement("li");
			li.textContent = communeLabel(c) + " ";
			const small = document.createElement("small");
			small.textContent = `INSEE ${c.code}${c.codesPostaux?.length ? ` · CP ${c.codesPostaux.join(", ")}` : ""}`;
			li.appendChild(small);
			li.addEventListener("mousedown", e => {
				e.preventDefault();
				chooseSuggestion(i);
			});
			communeSuggestions.appendChild(li);
		});
		communeSuggestions.hidden = false;
	}

	function highlightSuggestion(i) {
		activeSuggestion = i;
		[...communeSuggestions.children].forEach((li, idx) => li.classList.toggle("active", idx === i));
	}

	async function chooseSuggestion(i) {
		const c = suggestionItems[i];
		communeSuggestions.hidden = true;
		if(!c) { return; }
		communeInput.value = c.nom;
		await selectCommune(c.code);
	}

	async function selectCommune(code) {
		selectedCommune = null;
		communeSelected.textContent = "Chargement du contour de la commune…";
		try {
			const c = await loadCommune(code);
			if(!c.contour) { throw new Error("contour indisponible"); }
			selectedCommune = c;
			communeInput.value = c.nom;
			communeSelected.textContent = `${communeLabel(c)} · INSEE ${c.code}`;
		}
		catch(err) {
			communeSelected.textContent = `Impossible de charger la commune : ${err.message}`;
		}
		return selectedCommune;
	}

	const onCommuneInput = debounce(async () => {
		const q = communeInput.value;
		try {
			renderSuggestions(await searchCommunes(q));
		}
		catch(err) {
			renderSuggestions([]);
			communeSelected.textContent = `Recherche de commune impossible : ${err.message}`;
		}
	}, 250);

	communeInput.addEventListener("input", () => {
		selectedCommune = null;
		communeSelected.textContent = "";
		onCommuneInput();
	});

	communeInput.addEventListener("keydown", e => {
		if(communeSuggestions.hidden) { return; }
		if(e.key === "ArrowDown") {
			e.preventDefault();
			highlightSuggestion(Math.min(activeSuggestion + 1, suggestionItems.length - 1));
		}
		else if(e.key === "ArrowUp") {
			e.preventDefault();
			highlightSuggestion(Math.max(activeSuggestion - 1, 0));
		}
		else if(e.key === "Enter" && activeSuggestion >= 0) {
			e.preventDefault();
			chooseSuggestion(activeSuggestion);
		}
		else if(e.key === "Escape") {
			communeSuggestions.hidden = true;
		}
	});

	communeInput.addEventListener("blur", () => { communeSuggestions.hidden = true; });

	sourceSelect.addEventListener("change", () => {
		sourceCustom.hidden = sourceSelect.value !== "custom";
		sourceCustom.required = sourceSelect.value === "custom";
	});

	// ---------------------------------------------------------------------------------------------
	// Panoramax search
	// ---------------------------------------------------------------------------------------------

	/** Small concurrency limiter: tasks with the highest priority run first (FIFO among equals) */
	function limiter(max) {
		let running = 0;
		const queue = [];
		const next = () => {
			if(running >= max || !queue.length) { return; }
			running++;
			let best = 0;
			for(let i = 1; i < queue.length; i++) {
				if(queue[i].priority > queue[best].priority) { best = i; }
			}
			const { fn, resolve, reject } = queue.splice(best, 1)[0];
			fn().then(resolve, reject).finally(() => {
				running--;
				next();
			});
		};
		return (fn, priority = 0) => new Promise((resolve, reject) => {
			queue.push({ fn, priority, resolve, reject });
			next();
		});
	}

	/**
	 * Errors worth retrying on smaller areas: server errors (timeouts show up as HTTP 500/504), rate limiting,
	 * and network failures (gateway errors without CORS headers, connection reset, response cut while reading…),
	 * which browsers report as TypeError ("Failed to fetch", "NetworkError when attempting to fetch resource")
	 * or as a JSON parsing error on a truncated body.
	 */
	function isServerError(err) {
		if(err.name === "AbortError") { return false; }
		if(err.status) { return err.status >= 500 || err.status === 429; }
		return true;
	}

	async function searchPictures(apiBase, contour, filter, signal, onProgress) {
		const run = limiter(MAX_PARALLEL_REQUESTS);
		const found = new Map();
		const stats = { requests: 0, successes: 0, errors: 0, truncated: false, errorSplits: 0, failedAreas: 0, lastError: null };
		const progress = () => onProgress(found.size, stats);
		// Aborted either by the user (cancel) or when the server is considered down
		const abortAll = new AbortController();
		signal.addEventListener("abort", () => abortAll.abort());
		let serverDown = false;

		async function searchArea(area, depth, errorDepth) {
			const params = new URLSearchParams({
				bbox: area.map(n => n.toFixed(7)).join(","),
				limit: String(SEARCH_LIMIT),
				filter,
			});
			let data;
			try {
				// Deeper (smaller) areas first: a failing area is explored down before moving on to the next one
				data = await run(() => fetchJson(`${apiBase}/search?${params}`, abortAll.signal), depth);
			}
			catch(err) {
				if(!isServerError(err)) { throw err; }
				stats.requests++;
				stats.errors++;
				stats.lastError = err;
				if(errorDepth < MAX_ERROR_SPLIT_DEPTH) {
					stats.errorSplits++;
					progress();
					const subs = splitBbox(area).filter(sub => rectIntersectsGeometry(sub, contour));
					await Promise.all(subs.map(sub => searchArea(sub, depth + 1, errorDepth + 1)));
				}
				else {
					stats.failedAreas++;
					if(stats.successes === 0 && stats.failedAreas >= MAX_FAILED_AREAS_WITHOUT_SUCCESS) {
						serverDown = true;
						abortAll.abort();
						throw err;
					}
					progress();
				}
				return;
			}
			stats.requests++;
			stats.successes++;
			const features = data.features || [];
			if(features.length >= SEARCH_LIMIT) {
				if(depth < MAX_SPLIT_DEPTH) {
					const subs = splitBbox(area).filter(sub => rectIntersectsGeometry(sub, contour));
					await Promise.all(subs.map(sub => searchArea(sub, depth + 1, errorDepth)));
					return;
				}
				stats.truncated = true;
			}
			for(const f of features) { found.set(f.id, f); }
			progress();
		}

		const cells = gridCells(geometryBbox(contour), INITIAL_CELL_SIZE_DEG, contour);
		stats.cells = cells.length;
		try {
			await Promise.all(cells.map(cell => searchArea(cell, 0, 0)));
		}
		catch(err) {
			throw serverDown ? stats.lastError : err;
		}

		if(stats.successes === 0 && stats.lastError) {
			// Nothing worked at all: report the server error
			throw stats.lastError;
		}
		return { features: [...found.values()], stats };
	}

	function originOf(feature, sourceApi) {
		// The meta-catalog adds a "via" link to the original instance
		const via = (feature.links || []).find(l => l.rel === "via" && l.href);
		const apiBase = via ? normalizeApiBase(via.href) : sourceApi;
		return {
			apiBase,
			viewerBase: viewerBaseFromApi(apiBase),
			name: via?.instance_name || new URL(apiBase).host,
		};
	}

	function collectionOf(feature) {
		if(feature.collection) { return feature.collection; }
		const parent = (feature.links || []).find(l => l.rel === "parent" || l.rel === "collection");
		const m = parent?.href.match(/collections\/([^/?#]+)/);
		return m ? m[1] : null;
	}

	function featureToTask(feature, sourceApi) {
		const props = feature.properties || {};
		const origin = originOf(feature, sourceApi);
		const [lon, lat] = feature.geometry.coordinates;
		return {
			id: feature.id,
			collection: collectionOf(feature),
			rank: props["geovisio:rank_in_collection"] ?? 0,
			datetime: props.datetime || "",
			producer: props["geovisio:producer"] || (feature.providers || []).map(p => p.name).filter(Boolean)[0] || "",
			thumb: feature.assets?.thumb?.href || props["geovisio:thumbnail"] || "",
			lon,
			lat,
			apiBase: origin.apiBase,
			viewerBase: origin.viewerBase,
			instanceName: origin.name,
			checkState: null, // { level: ok|todo|err, text }
		};
	}

	function viewerUrl(task) {
		return `${task.viewerBase}/?focus=pic&pic=${encodeURIComponent(task.id)}`;
	}

	async function runSearch() {
		if(currentSearch) { currentSearch.abort(); }

		const tag = getTagFromForm();
		if(!tag.key || !tag.values.length) {
			setStatus("Indiquez la clé et au moins une valeur de tag.", "error");
			return;
		}
		const apiBase = getSourceApi();
		if(!apiBase) {
			setStatus("Indiquez l'URL de l'instance Panoramax.", "error");
			return;
		}
		if(!selectedCommune) {
			const first = await searchCommunes(communeInput.value).catch(() => []);
			if(first.length === 1 || (first[0] && first[0].nom.toLowerCase() === communeInput.value.trim().toLowerCase())) {
				await selectCommune(first[0].code);
			}
		}
		if(!selectedCommune) {
			setStatus("Choisissez une commune dans la liste de suggestions.", "error");
			return;
		}

		const commune = selectedCommune;
		const controller = new AbortController();
		currentSearch = controller;
		updateUrl(commune, tag);
		searchBtn.disabled = true;
		cancelBtn.hidden = false;
		resultsEl.hidden = true;
		setStatus(`Recherche des images dans ${commune.nom}…`);

		try {
			const filter = buildCqlFilter(tag);
			const { features, stats } = await searchPictures(apiBase, commune.contour, filter, controller.signal, (n, s) => {
				let msg = `Recherche des images dans ${commune.nom}… ${n} image(s) taguée(s) trouvée(s) (${s.requests} requête(s)`;
				if(s.errorSplits) { msg += `, ${s.errorSplits} zone(s) redécoupée(s) après une erreur du serveur`; }
				setStatus(msg + ")");
			});

			let outside = 0, withZone = 0;
			const selected = [];
			for(const f of features) {
				if(f.geometry?.type !== "Point" || !pointInGeometry(f.geometry.coordinates, commune.contour)) {
					outside++;
					continue;
				}
				if(zoneStatus(f, tag) !== "todo") {
					withZone++;
					continue;
				}
				selected.push(featureToTask(f, apiBase));
			}

			selected.sort((a, b) =>
				(a.collection || "").localeCompare(b.collection || "") || a.rank - b.rank || a.datetime.localeCompare(b.datetime)
			);
			tasks = selected;
			lastSearchTag = tag;

			let msg = `${commune.nom} : ${tasks.length} image(s) avec le tag sans zone`;
			msg += ` (${withZone} image(s) ont déjà une zone, ${outside} hors de la commune ignorée(s)).`;
			if(stats.truncated) {
				msg += " Attention : zone très dense, certains résultats ont pu être tronqués.";
			}
			if(stats.failedAreas) {
				msg += ` Attention : ${stats.failedAreas} petite(s) zone(s) n'ont pas pu être interrogées`
					+ ` (${stats.lastError?.status ? `HTTP ${stats.lastError.status}` : "erreur réseau"}),`
					+ " la liste peut être incomplète. Relancez la recherche plus tard pour les récupérer.";
			}
			setStatus(msg, stats.truncated || stats.failedAreas ? "warn" : "");
			renderTasks();
			resultsEl.hidden = false;
		}
		catch(err) {
			if(err.name === "AbortError") {
				setStatus("Recherche annulée.", "warn");
			}
			else {
				setStatus(`Erreur lors de la recherche : ${err.message}`, "error");
			}
		}
		finally {
			if(currentSearch === controller) { currentSearch = null; }
			searchBtn.disabled = false;
			cancelBtn.hidden = true;
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Re-check a picture on its original instance
	// ---------------------------------------------------------------------------------------------
	async function recheck(task) {
		task.checkState = { level: "", text: "Vérification…" };
		renderTasks();
		try {
			const url = task.collection
				? `${task.apiBase}/collections/${encodeURIComponent(task.collection)}/items/${encodeURIComponent(task.id)}`
				: `${task.apiBase}/pictures/${encodeURIComponent(task.id)}`;
			const feature = await fetchJson(url);
			const status = zoneStatus(feature, lastSearchTag);
			if(status === "has-zone") {
				task.checkState = { level: "ok", text: "✔ Zone présente" };
				setDone(task.id, true);
			}
			else if(status === "no-tag") {
				task.checkState = { level: "ok", text: "✔ Le tag n'est plus sur l'image" };
				setDone(task.id, true);
			}
			else {
				task.checkState = { level: "todo", text: "Toujours sans zone" };
				setDone(task.id, false);
			}
		}
		catch(err) {
			task.checkState = { level: "err", text: err.status === 404 ? "Image introuvable" : `Erreur : ${err.message}` };
		}
		renderTasks();
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------------------------
	function formatDate(iso) {
		if(!iso) { return ""; }
		const d = new Date(iso);
		return isNaN(d) ? iso : d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
	}

	function renderTasks() {
		const total = tasks.length;
		const doneCount = tasks.filter(t => isDone(t.id)).length;
		countersEl.textContent = `${total - doneCount} à traiter · ${doneCount} traitée(s) · ${total} au total`;

		const hideDone = hideDoneInput.checked;
		const fragment = document.createDocumentFragment();
		tasks.forEach((task, i) => {
			const done = isDone(task.id);
			if(hideDone && done) { return; }

			const li = document.createElement("li");
			li.className = "task" + (done ? " done" : "");

			const index = document.createElement("span");
			index.className = "index";
			index.textContent = String(i + 1);
			li.appendChild(index);

			const thumbLink = document.createElement("a");
			thumbLink.href = viewerUrl(task);
			thumbLink.target = "_blank";
			thumbLink.rel = "noopener";
			const img = document.createElement("img");
			img.className = "thumb";
			img.loading = "lazy";
			img.alt = `Miniature de l'image ${task.id}`;
			if(task.thumb) { img.src = task.thumb; }
			thumbLink.appendChild(img);
			li.appendChild(thumbLink);

			const meta = document.createElement("div");
			meta.className = "meta";

			const title = document.createElement("strong");
			title.textContent = formatDate(task.datetime) || task.id;
			meta.appendChild(title);

			const line1 = document.createElement("span");
			line1.className = "line";
			line1.textContent = [task.instanceName, task.producer && `par ${task.producer}`].filter(Boolean).join(" · ");
			meta.appendChild(line1);

			const line2 = document.createElement("span");
			line2.className = "line";
			line2.textContent = `${task.id} · ${task.lat.toFixed(6)}, ${task.lon.toFixed(6)}`;
			meta.appendChild(line2);

			const buttons = document.createElement("div");
			buttons.className = "buttons";

			const open = document.createElement("a");
			open.className = "open-link";
			open.href = viewerUrl(task);
			open.target = "_blank";
			open.rel = "noopener";
			open.textContent = "Ouvrir dans Panoramax ↗";
			buttons.appendChild(open);

			const checkBtn = document.createElement("button");
			checkBtn.type = "button";
			checkBtn.textContent = "Revérifier";
			checkBtn.addEventListener("click", () => recheck(task));
			buttons.appendChild(checkBtn);

			const doneLabel = document.createElement("label");
			const doneBox = document.createElement("input");
			doneBox.type = "checkbox";
			doneBox.checked = done;
			doneBox.addEventListener("change", () => {
				setDone(task.id, doneBox.checked);
				renderTasks();
			});
			doneLabel.append(doneBox, " Traitée");
			buttons.appendChild(doneLabel);

			if(task.checkState) {
				const state = document.createElement("span");
				state.className = `check-state ${task.checkState.level}`;
				state.textContent = task.checkState.text;
				buttons.appendChild(state);
			}

			meta.appendChild(buttons);
			li.appendChild(meta);
			fragment.appendChild(li);
		});
		taskList.replaceChildren(fragment);
	}

	hideDoneInput.addEventListener("change", renderTasks);

	recheckAllBtn.addEventListener("click", async () => {
		recheckAllBtn.disabled = true;
		const run = limiter(MAX_PARALLEL_REQUESTS);
		await Promise.all(tasks.map(t => run(() => recheck(t))));
		recheckAllBtn.disabled = false;
	});

	exportBtn.addEventListener("click", () => {
		const header = ["numero", "id", "instance", "date", "latitude", "longitude", "lien", "traitee"];
		const rows = tasks.map((t, i) => [
			i + 1, t.id, t.instanceName, t.datetime, t.lat, t.lon, viewerUrl(t), isDone(t.id) ? "oui" : "non",
		]);
		const csv = [header, ...rows]
			.map(r => r.map(v => `"${String(v).replace(/"/g, "\"\"")}"`).join(";"))
			.join("\r\n");
		const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `checkmym12-${selectedCommune?.code || "export"}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	});

	// ---------------------------------------------------------------------------------------------
	// URL state (lets you bookmark a search)
	// ---------------------------------------------------------------------------------------------
	function updateUrl(commune, tag) {
		const params = new URLSearchParams();
		params.set("commune", commune.code);
		params.set("source", getSourceApi());
		if(tag.key !== "osm|traffic_sign") { params.set("key", tag.key); }
		if(tag.values.join(",") !== "FR:M12") { params.set("values", tag.values.join(",")); }
		history.replaceState(null, "", `${location.pathname}?${params}`);
	}

	async function restoreFromUrl() {
		const params = new URLSearchParams(location.search);
		const source = params.get("source");
		if(source) {
			const option = [...sourceSelect.options].find(o => o.value === normalizeApiBase(source));
			if(option) { sourceSelect.value = option.value; }
			else {
				sourceSelect.value = "custom";
				sourceCustom.value = source;
				sourceCustom.hidden = false;
			}
		}
		if(params.get("key")) { tagKeyInput.value = params.get("key"); }
		if(params.get("values")) { tagValuesInput.value = params.get("values"); }
		const code = params.get("commune");
		if(code && await selectCommune(code)) {
			runSearch();
		}
	}

	form.addEventListener("submit", e => {
		e.preventDefault();
		runSearch();
	});
	cancelBtn.addEventListener("click", () => currentSearch?.abort());

	restoreFromUrl();
})();
