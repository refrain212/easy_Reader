// ── PDF.js worker ──
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── State ──
let rawLines = [];
let lineElements = [];
let tocEntries = [];
let results = [];
let curIdx = -1;
let fontSize = 18;
let dark = false;
let currentBookId = null;
let layoutMode = 'scroll'; // 'scroll' | 'columns'
let currentPage = 0;
let totalPages = 1;
let exactPageW = 0;
let pageLineMap = []; // pageLineMap[p] = sorted array of line indices on page p
let lineToPage = []; // lineToPage[lineIndex] = page index
let curMarkEl = null; // currently highlighted search mark element
let layoutCache = null; // cached page map: { bookId, fontSize, fontFamily, vpW, ctH, … }
let fontFamily = "'Source Han Serif CN','思源宋体','STSong','SimSun',serif";
let currentNoteChapter = '';
let currentNoteLineIndex = 0;
let currentAnnotations = [];
let pendingAnnot = null;
let annotCtxAid  = null;

const FONT_FAMILIES = [
    { name: '宋体', value: "'Source Han Serif CN','思源宋体','STSong','SimSun',serif" },
    { name: '楷体', value: "'STKaiti','KaiTi',serif" },
    { name: '仿宋', value: "'STFangsong','FangSong',serif" },
    { name: '黑体', value: "'PingFang SC','Microsoft YaHei',sans-serif" },
    { name: '等宽', value: "monospace" },
];

// ── DOM ──
const fi            = document.getElementById('fi');
const si            = document.getElementById('si');
const sc            = document.getElementById('sc');
const ct            = document.getElementById('ct');
const tocPanel      = document.getElementById('toc-panel');
const tocBackdrop   = document.getElementById('toc-backdrop');
const tl            = document.getElementById('toc-list');
const rd            = document.getElementById('reader');
const wl            = document.getElementById('welcome');
const ld            = document.getElementById('loading');
const rp            = document.getElementById('rp');
const rpBd          = document.getElementById('rp-bd');
const rpCnt         = document.getElementById('rp-cnt');
const shelfEl       = document.getElementById('shelf');
const shelfGrid     = document.getElementById('shelf-grid');
const sideBtns      = document.getElementById('side-btns');
const notesPanel    = document.getElementById('notes-panel');
const notesBackdrop = document.getElementById('notes-backdrop');
const notesList     = document.getElementById('notes-list');
const notesInput    = document.getElementById('notes-input');
const fontPanel     = document.getElementById('font-panel');
const fontBackdrop  = document.getElementById('font-backdrop');
const fpSlider      = document.getElementById('fp-slider');
const fpSizeVal     = document.getElementById('fp-size-val');
const pgNav         = document.getElementById('pg-nav');
const pgInfo        = document.getElementById('pg-info');
const colVp         = document.getElementById('col-vp');

// ── Helpers ──
function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function normPath(base, href) {
    const parts = (base + href).split('/');
    const r = [];
    for (const p of parts) {
        if (p === '..') r.pop();
        else if (p && p !== '.') r.push(p);
    }
    return r.join('/');
}

// ── IndexedDB ──
const DB_NAME = 'gudji-reader';
const DB_VER  = 1;
const STORE   = 'books';

function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = e => res(e.target.result);
        req.onerror   = rej;
    });
}

async function loadBooks() {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = e => res(e.target.result.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)));
        req.onerror   = rej;
    });
}

async function upsertBook(data) {
    const books = await loadBooks();
    const existing = books.find(b => b.filename === data.filename);
    const db = await openDB();
    if (existing) {
        const updated = { ...existing, content: data.content, size: data.size, lastOpenedAt: Date.now() };
        await new Promise((res, rej) => {
            const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(updated);
            req.onsuccess = res; req.onerror = rej;
        });
        return existing.id;
    }
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).add({
            ...data, addedAt: Date.now(), lastOpenedAt: Date.now(), lastLine: 0, lastChapter: '', notes: [],
        });
        req.onsuccess = e => res(e.target.result);
        req.onerror   = rej;
    });
}

async function deleteBook(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
        req.onsuccess = res; req.onerror = rej;
    });
}

function savePosition(id, lineIndex, chapter) {
    openDB().then(db => {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const req = store.get(id);
        req.onsuccess = e => {
            if (!e.target.result) return;
            store.put({ ...e.target.result, lastLine: lineIndex, lastChapter: chapter, lastOpenedAt: Date.now() });
        };
    });
}

async function getNotes(bookId) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(bookId);
        req.onsuccess = e => res(e.target.result?.notes || []);
        req.onerror = rej;
    });
}

async function saveNotes(bookId, notes) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const req = store.get(bookId);
        req.onsuccess = e => {
            if (!e.target.result) { res(); return; }
            const r = store.put({ ...e.target.result, notes });
            r.onsuccess = res; r.onerror = rej;
        };
        req.onerror = rej;
    });
}

async function getAnnotations(bookId) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(bookId);
        req.onsuccess = e => res(e.target.result?.annotations || []);
        req.onerror   = rej;
    });
}

async function saveAnnotations(bookId, annotations) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const req = store.get(bookId);
        req.onsuccess = e => {
            if (!e.target.result) { res(); return; }
            store.put({ ...e.target.result, annotations }).onsuccess = res;
        };
        req.onerror = rej;
    });
}

// ── File open ──
document.getElementById('btn-open').onclick = () => fi.click();
fi.onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); fi.value = ''; };

ct.addEventListener('dragover', e => { e.preventDefault(); ct.classList.add('dragover'); });
ct.addEventListener('dragleave', () => ct.classList.remove('dragover'));
ct.addEventListener('drop', e => {
    e.preventDefault(); ct.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    showState('loading');
    try {
        let text;
        if      (ext === 'txt')  text = await readText(file);
        else if (ext === 'pdf')  text = await parsePdf(file);
        else if (ext === 'epub') text = await parseEpub(file);
        else { alert('不支持的格式，请使用 TXT、PDF 或 EPUB 文件'); await goToShelf(); return; }
        currentBookId = await upsertBook({
            name: file.name.replace(/\.[^.]+$/, ''),
            filename: file.name,
            type: ext,
            content: text,
            size: text.length,
        });
        await render(text);
        document.title = file.name.replace(/\.[^.]+$/, '') + ' — 简单阅读器';
        currentAnnotations = await getAnnotations(currentBookId);
        applyAnnotations();
    } catch (err) {
        console.error(err);
        alert('加载失败：' + err.message);
        await goToShelf();
    }
}

function readText(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = rej;
        r.readAsText(file, 'UTF-8');
    });
}
function readAB(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = rej;
        r.readAsArrayBuffer(file);
    });
}

// ── PDF parser ──
async function parsePdf(file) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js 未加载（请检查网络）');
    const ab = await readAB(file);
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let buf = '', lastY = null;
        for (const item of content.items) {
            if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) buf += '\n';
            buf += item.str;
            lastY = item.transform[5];
        }
        pages.push(buf);
    }
    return pages.join('\n');
}

// ── EPUB parser ──
async function parseEpub(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载（请检查网络）');
    const ab = await readAB(file);
    const zip = await JSZip.loadAsync(ab);

    const containerXml = await zip.file('META-INF/container.xml').async('string');
    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/i)?.[1];
    if (!opfPath) throw new Error('无法解析 EPUB 结构');

    const opfBase = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = await zip.file(opfPath).async('string');

    const manifest = {};
    const mRe = /<item\b([^>]*)>/gi;
    let m;
    while ((m = mRe.exec(opfXml)) !== null) {
        const attrs = m[1];
        const id   = attrs.match(/\bid="([^"]+)"/)?.[1];
        const href = attrs.match(/\bhref="([^"]+)"/)?.[1];
        if (id && href) manifest[id] = decodeURIComponent(href);
    }

    const spine = [];
    const sRe = /<itemref\b[^>]*idref="([^"]+)"/gi;
    while ((m = sRe.exec(opfXml)) !== null) spine.push(m[1]);

    const parts = [];
    for (const id of spine) {
        if (!manifest[id]) continue;
        const fullPath = normPath(opfBase, manifest[id]);
        const f = zip.file(fullPath) || zip.file(manifest[id]);
        if (!f) continue;
        const html = await f.async('string');
        const t = htmlToText(html);
        if (t.trim()) parts.push(t);
    }
    return parts.join('\n');
}

function htmlToText(html) {
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<\/?(p|div|h[1-6]|br|li|tr|td|th)\b[^>]*>/gi, '\n');
    html = html.replace(/<[^>]+>/g, '');
    return html
        .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"')
        .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n))
        .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))
        .replace(/\n{3,}/g,'\n\n').trim();
}

// ── TOC Detection ──
const TOC_PATTERNS = [
    { re: /^【.{1,50}】\s*$/, level: 1 },
    { re: /^\s*◎/,            level: 2 },
    { re: /^第[零一二三四五六七八九十百千0-9]+[章节卷篇回]/, level: 1 },
    { re: /^卷[零一二三四五六七八九十百千0-9一]/,            level: 1 },
    { re: /^Chapter\s+\d+/i,  level: 1 },
    { re: /^Part\s+[IVXivx\d]+/i, level: 1 },
];

function detectToc(lines) {
    const active = TOC_PATTERNS.filter(p =>
        lines.filter(l => p.re.test(l.trim())).length >= 2
    );
    const entries = [];
    lines.forEach((line, i) => {
        const t = line.trim();
        for (const p of active) {
            if (p.re.test(t)) {
                entries.push({ level: p.level, title: t.replace(/^\s*◎\s*/, '◎ '), lineIndex: i });
                break;
            }
        }
    });
    return entries;
}

// ── Rendering ──
async function render(text) {
    await new Promise(r => setTimeout(r, 10));
    rawLines = text.split('\n');
    tocEntries = detectToc(rawLines);
    const tocSet = new Set(tocEntries.map(e => e.lineIndex));

    currentAnnotations = [];
    lineElements = new Array(rawLines.length);
    const frag = document.createDocumentFragment();

    rawLines.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'ln';
        el.dataset.line = i;
        el.textContent = line;
        lineElements[i] = el;

        const t = line.trim();
        if      (/^【.{1,50}】\s*$/.test(t))                             el.classList.add('ln-h1');
        else if (/^\s*◎/.test(t))                                         el.classList.add('ln-h2');
        else if (/^(作品|作者|分类|网址|简介|出版|ISBN)：/.test(t))        el.classList.add('ln-meta');

        if (tocSet.has(i)) el.id = 'a' + i;
        frag.appendChild(el);
    });

    rd.innerHTML = '';
    rd.appendChild(frag);
    rd.style.fontSize = fontSize + 'px';
    rd.style.fontFamily = fontFamily;
    rd.style.transform = '';
    rd.style.height = '';
    rd.classList.remove('columns-mode');
    ct.classList.remove('columns-mode');
    colVp.classList.remove('active');
    currentPage = 0; totalPages = 1; exactPageW = 0;
    pageLineMap = []; lineToPage = []; curMarkEl = null; layoutCache = null;

    renderToc();
    clearSearch();
    showState('reader');
    ct.scrollTop = 0;

    if (layoutMode === 'columns') {
        // re-enter columns after DOM settles
        requestAnimationFrame(() => requestAnimationFrame(() => applyColumnsMode()));
    }
}

function renderToc() {
    tl.innerHTML = '';
    if (tocEntries.length === 0) {
        tl.innerHTML = '<div style="padding:10px 14px;color:var(--muted);font-size:12px;">未检测到目录结构</div>';
        return;
    }
    const frag = document.createDocumentFragment();
    tocEntries.forEach(e => {
        const d = document.createElement('div');
        d.className = 'ti l' + e.level;
        d.textContent = e.title;
        d.title = e.title;
        d.dataset.line = e.lineIndex;
        d.onclick = () => {
            closeToc();
            scrollToLine(e.lineIndex);
        };
        frag.appendChild(d);
    });
    tl.appendChild(frag);
}

// ── Scrollspy ──
const debouncedSavePos = debounce((lineIndex, chapter) => {
    if (currentBookId) savePosition(currentBookId, lineIndex, chapter);
}, 1000);

ct.addEventListener('scroll', debounce(() => {
    updatePgInfo();
    if (!tocEntries.length) return;
    const top = ct.getBoundingClientRect().top;
    let cur = tocEntries[0];
    for (const e of tocEntries) {
        const el = lineElements[e.lineIndex];
        if (!el) continue;
        if (el.getBoundingClientRect().top - top <= 64) cur = e;
        else break;
    }
    document.querySelectorAll('.ti.active').forEach(x => x.classList.remove('active'));
    const el = tl.querySelector(`[data-line="${cur.lineIndex}"]`);
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
    currentNoteChapter = cur.title;
    currentNoteLineIndex = cur.lineIndex;
    debouncedSavePos(cur.lineIndex, cur.title);
}, 120));

function updatePgInfo() {
    if (layoutMode !== 'columns' || totalPages <= 0) { pgInfo.textContent = ''; return; }
    pgInfo.textContent = `${currentPage + 1} / ${totalPages}`;
    pgInfo.title = '点击跳转页面';
}

pgInfo.onclick = () => {
    if (layoutMode !== 'columns' || totalPages <= 0) return;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = 1; inp.max = totalPages; inp.value = currentPage + 1;
    inp.style.cssText = 'width:54px;text-align:center;font-size:12px;font-family:inherit;' +
        'border:1px solid var(--accent);border-radius:3px;background:var(--bg);' +
        'color:var(--text);outline:none;padding:1px 4px';
    pgInfo.textContent = '';
    pgInfo.appendChild(inp);
    inp.focus(); inp.select();
    const commit = () => {
        const v = parseInt(inp.value, 10);
        if (!isNaN(v)) goToPage(v - 1);
        updatePgInfo();
    };
    inp.onblur = commit;
    inp.onkeydown = e => {
        if (e.key === 'Enter') { commit(); e.stopPropagation(); }
        if (e.key === 'Escape') { updatePgInfo(); e.stopPropagation(); }
    };
};

// ── Search ──
si.addEventListener('input', debounce(doSearch, 180));
si.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        if (rp.style.display !== 'none') { hidePanel(); return; }
        e.shiftKey ? prevR() : nextR();
    } else if (e.key === 'Escape') {
        if (rp.style.display !== 'none') hidePanel();
        else clearSearch();
    }
});
document.getElementById('btn-next').onclick = nextR;
document.getElementById('btn-prev').onclick = prevR;
document.getElementById('btn-clr').onclick = clearSearch;

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (rp.style.display !== 'none') { hidePanel(); }
        else { si.focus(); si.select(); if (results.length > 0) showPanel(); }
        return;
    }
    if (e.key === 'Escape' && document.activeElement !== si) {
        if (notesPanel.classList.contains('open')) { closeNotes(); return; }
        if (fontPanel.classList.contains('open'))  { closeFont();  return; }
        if (tocPanel.classList.contains('open'))   { closeToc();   return; }
        if (rp.style.display !== 'none') { hidePanel(); return; }
    }
    const tag = e.target.tagName;
    if (layoutMode === 'columns' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        if (e.key === 'ArrowRight') { goToPage(currentPage + 1); e.preventDefault(); }
        if (e.key === 'ArrowLeft')  { goToPage(currentPage - 1); e.preventDefault(); }
    }
});

function doSearch() {
    clearHighlights();
    const q = si.value.trim();
    si.classList.remove('no-result');
    if (!q) { results = []; curIdx = -1; updateUI(); hidePanel(); return; }

    const t0 = performance.now();
    const found = [];
    const re = new RegExp(escRe(q), 'gi');
    rawLines.forEach((line, li) => {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
            found.push({ li, s: m.index, e: m.index + m[0].length });
        }
    });
    const elapsed = Math.round(performance.now() - t0);
    results = found;
    curIdx = found.length ? 0 : -1;
    if (!found.length) { si.classList.add('no-result'); hidePanel(); }
    else { buildResultsPanel(q, elapsed); showPanel(); }
    highlightAll();
    updateUI();
}

// ── Results Panel ──
const MAX_SHOW = 500;
const PER_GROUP = 5;

function getChapter(lineIndex) {
    let ch = null;
    for (const e of tocEntries) {
        if (e.lineIndex <= lineIndex) ch = e;
        else break;
    }
    return ch;
}

function getContext(r) {
    const line = rawLines[r.li];
    const WIN = 50;
    const bStart = Math.max(0, r.s - WIN);
    const aEnd   = Math.min(line.length, r.e + WIN);
    return {
        pre:   (bStart > 0 ? '…' : '') + line.slice(bStart, r.s),
        match: line.slice(r.s, r.e),
        post:  line.slice(r.e, aEnd) + (aEnd < line.length ? '…' : ''),
    };
}

function buildResultsPanel(q, elapsed) {
    const shown = results.slice(0, MAX_SHOW);
    const capped = results.length > MAX_SHOW;
    rpCnt.textContent = capped
        ? `${results.length} 条结果（仅显示前 ${MAX_SHOW} 条），用时 ${elapsed} 毫秒`
        : `${results.length} 条结果，用时 ${elapsed} 毫秒`;

    const groups = [];
    let curG = null;
    shown.forEach((r, i) => {
        const ch = getChapter(r.li);
        const key = ch ? ch.lineIndex : -1;
        if (!curG || curG.key !== key) {
            curG = { key, title: ch ? ch.title : '（正文）', items: [] };
            groups.push(curG);
        }
        curG.items.push({ r, gi: i });
    });

    const frag = document.createDocumentFragment();
    for (const g of groups) {
        const gDiv = document.createElement('div');
        gDiv.className = 'rg';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'rg-title';
        titleDiv.textContent = g.title;
        gDiv.appendChild(titleDiv);

        g.items.slice(0, PER_GROUP).forEach(({ r, gi }) => {
            const ctx = getContext(r);
            const div = document.createElement('div');
            div.className = 'ri';
            div.innerHTML = esc(ctx.pre) + '<mark>' + esc(ctx.match) + '</mark>' + esc(ctx.post);
            div.onclick = () => {
                curIdx = gi;
                hidePanel();
                scrollToR(gi);
                refreshCur();
                updateUI();
            };
            gDiv.appendChild(div);
        });

        if (g.items.length > PER_GROUP) {
            const more = document.createElement('div');
            more.className = 'rg-more';
            more.textContent = `还有 ${g.items.length - PER_GROUP} 处 ›`;
            more.onclick = () => {
                const { gi } = g.items[PER_GROUP];
                curIdx = gi;
                hidePanel();
                scrollToR(gi);
                refreshCur();
                updateUI();
            };
            gDiv.appendChild(more);
        }

        frag.appendChild(gDiv);
    }

    rpBd.innerHTML = '';
    rpBd.appendChild(frag);
    rpBd.scrollTop = 0;
}

function showPanel() { rp.style.display = 'flex'; }
function hidePanel() { rp.style.display = 'none'; }

function highlightAll() {
    const byLine = new Map();
    results.forEach((r, i) => {
        if (!byLine.has(r.li)) byLine.set(r.li, []);
        byLine.get(r.li).push({ ...r, idx: i });
    });
    byLine.forEach((ms, li) => {
        const el = lineElements[li];
        if (!el) return;
        const orig = rawLines[li];
        let html = '', last = 0;
        ms.sort((a,b) => a.s - b.s);
        for (const m of ms) {
            html += esc(orig.slice(last, m.s));
            html += `<mark data-r="${m.idx}"${m.idx === curIdx ? ' class="cur"' : ''}>${esc(orig.slice(m.s, m.e))}</mark>`;
            last = m.e;
        }
        html += esc(orig.slice(last));
        el.innerHTML = html;
        el.classList.add('hl');
    });
}

function clearHighlights() {
    // Iterate lineElements directly — some may be detached (columns mode)
    lineElements.forEach((el, i) => {
        if (el && el.classList.contains('hl')) {
            el.textContent = rawLines[i];
            el.classList.remove('hl');
            applyAnnotationsToLine(el, i);
        }
    });
    curMarkEl = null;
}

function refreshCur() {
    if (curMarkEl) { curMarkEl.classList.remove('cur'); curMarkEl = null; }
    if (curIdx < 0 || !results[curIdx]) return;
    // lineElements[r.li] may be detached; querySelector works on detached nodes too
    const lineEl = lineElements[results[curIdx].li];
    if (!lineEl) return;
    const m = lineEl.querySelector(`mark[data-r="${curIdx}"]`);
    if (m) { m.classList.add('cur'); curMarkEl = m; }
}

function nextR() {
    if (!results.length) return;
    curIdx = (curIdx + 1) % results.length;
    scrollToR(curIdx); refreshCur(); updateUI();
}
function prevR() {
    if (!results.length) return;
    curIdx = (curIdx - 1 + results.length) % results.length;
    scrollToR(curIdx); refreshCur(); updateUI();
}
function scrollToR(i) {
    if (layoutMode === 'columns') {
        // Navigate to the page containing this result; mark will be in DOM after
        if (results[i]) goToPage(lineToPage[results[i].li] || 0);
    } else {
        const mark = document.querySelector(`mark[data-r="${i}"]`);
        if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
function clearSearch() {
    si.value = ''; si.classList.remove('no-result');
    clearHighlights(); results = []; curIdx = -1; updateUI(); hidePanel();
}
document.getElementById('rp-back').onclick = hidePanel;
function updateUI() {
    sc.textContent = results.length ? `${curIdx + 1} / ${results.length}` : (si.value ? '无结果' : '—');
}

// ── TOC panel ──
function openToc()  { tocPanel.classList.add('open'); tocBackdrop.classList.add('open'); }
function closeToc() { tocPanel.classList.remove('open'); tocBackdrop.classList.remove('open'); }
document.getElementById('toc-close').onclick = closeToc;
tocBackdrop.onclick = closeToc;

// ── Notes panel ──
function openNotes() {
    notesPanel.classList.add('open'); notesBackdrop.classList.add('open');
    renderNotesList();
}
function closeNotes() {
    notesPanel.classList.remove('open'); notesBackdrop.classList.remove('open');
}

async function renderNotesList() {
    if (!currentBookId) {
        notesList.innerHTML = '<div class="notes-empty">请先打开一本书</div>';
        return;
    }
    const notes = await getNotes(currentBookId);
    if (!notes.length) {
        notesList.innerHTML = '<div class="notes-empty">暂无笔记<br><small style="font-size:11px;margin-top:4px;display:block">在下方输入框记录当前章节的笔记</small></div>';
        return;
    }
    const frag = document.createDocumentFragment();
    [...notes].reverse().forEach(note => {
        const div = document.createElement('div');
        div.className = 'note-item';
        const d = new Date(note.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        div.innerHTML =
            (note.chapter ? `<div class="note-ch">${esc(note.chapter)}</div>` : '') +
            `<div class="note-text">${esc(note.text)}</div>` +
            `<div class="note-date">${d}</div>` +
            `<button class="note-del" data-id="${note.id}">✕</button>`;
        div.querySelector('.note-del').onclick = async e => {
            e.stopPropagation();
            const id = +e.currentTarget.dataset.id;
            const all = await getNotes(currentBookId);
            await saveNotes(currentBookId, all.filter(n => n.id !== id));
            renderNotesList();
        };
        frag.appendChild(div);
    });
    notesList.innerHTML = '';
    notesList.appendChild(frag);
}

document.getElementById('notes-save').onclick = async () => {
    const text = notesInput.value.trim();
    if (!text || !currentBookId) return;
    const notes = await getNotes(currentBookId);
    notes.push({
        id: Date.now(),
        text,
        lineIndex: currentNoteLineIndex,
        chapter: currentNoteChapter,
        createdAt: Date.now(),
    });
    await saveNotes(currentBookId, notes);
    notesInput.value = '';
    renderNotesList();
};

document.getElementById('notes-close').onclick = closeNotes;
notesBackdrop.onclick = closeNotes;

// ── Annotation helpers ──
function findLineEl(node) {
    while (node && node !== rd) {
        if (node.nodeType === 1 && node.classList.contains('ln')) return node;
        node = node.parentNode;
    }
    return null;
}

function getTextOffset(lineEl, node, offset) {
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let total = 0, cur;
    while ((cur = walker.nextNode())) {
        if (cur === node) return total + offset;
        total += cur.textContent.length;
    }
    return total;
}

function applyAnnotationsToLine(el, lineIndex) {
    const anns = currentAnnotations.filter(a => a.lineIndex === lineIndex);
    if (!anns.length) {
        if (el.querySelector('.annot-hl,.annot-wave,.annot-line')) {
            el.textContent = rawLines[lineIndex];
        }
        return;
    }
    const text = rawLines[lineIndex];
    anns.sort((a, b) => a.start - b.start);
    let html = '', last = 0;
    for (const a of anns) {
        const s = Math.max(a.start, last);
        const e = Math.min(a.end, text.length);
        if (s >= e) continue;
        html += esc(text.slice(last, s));
        html += `<span class="annot-${a.type}" data-aid="${a.id}">${esc(text.slice(s, e))}</span>`;
        last = e;
    }
    html += esc(text.slice(last));
    el.innerHTML = html;
}

function applyAnnotations() {
    if (!currentAnnotations.length) return;
    const seen = new Set(currentAnnotations.map(a => a.lineIndex));
    seen.forEach(li => {
        const el = lineElements[li];
        if (el) applyAnnotationsToLine(el, li);
    });
}

// ── Annotation popup ──
const annotMenu   = document.getElementById('annot-menu');
const annotCtxEl  = document.getElementById('annot-ctx');

function showAnnotMenu(rect, lineIndex, start, end, text) {
    pendingAnnot = { lineIndex, start, end, text };
    const cx = rect.left + rect.width / 2;
    const popH = 78;
    let top = rect.top - popH - 10;
    if (top < 6) top = rect.bottom + 10; // flip below if near top edge
    annotMenu.style.left = cx + 'px';
    annotMenu.style.top  = top + 'px';
    annotMenu.classList.add('visible');
}

function hideAnnotMenu() {
    annotMenu.classList.remove('visible');
    pendingAnnot = null;
}

function hideAnnotCtx() {
    annotCtxEl.classList.remove('visible');
    annotCtxAid = null;
}

document.addEventListener('mousedown', e => {
    if (!annotMenu.contains(e.target))   hideAnnotMenu();
    if (!annotCtxEl.contains(e.target))  hideAnnotCtx();
});

document.addEventListener('mouseup', () => {
    if (annotMenu.classList.contains('visible')) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!rd || !rd.contains(range.startContainer)) return;
    const startLineEl = findLineEl(range.startContainer);
    const endLineEl   = findLineEl(range.endContainer);
    if (!startLineEl || startLineEl !== endLineEl) return;
    const lineIndex = parseInt(startLineEl.dataset.line, 10);
    const start = getTextOffset(startLineEl, range.startContainer, range.startOffset);
    const end   = getTextOffset(startLineEl, range.endContainer,   range.endOffset);
    if (start >= end) return;
    const selText = rawLines[lineIndex].slice(start, end);
    showAnnotMenu(range.getBoundingClientRect(), lineIndex, start, end, selText);
});

rd.addEventListener('contextmenu', e => {
    e.preventDefault();
    const span = e.target.closest('[data-aid]');
    if (!span) return;
    hideAnnotMenu();
    annotCtxAid = parseInt(span.dataset.aid, 10);
    annotCtxEl.style.left = e.clientX + 'px';
    annotCtxEl.style.top  = e.clientY + 'px';
    annotCtxEl.classList.add('visible');
});

document.getElementById('annot-ctx-del').onclick = async () => {
    if (annotCtxAid === null || !currentBookId) { hideAnnotCtx(); return; }
    const aid = annotCtxAid;
    hideAnnotCtx();
    const delAnn = currentAnnotations.find(a => a.id === aid);
    currentAnnotations = currentAnnotations.filter(a => a.id !== aid);
    await saveAnnotations(currentBookId, currentAnnotations);
    if (delAnn) {
        const el = lineElements[delAnn.lineIndex];
        if (el) applyAnnotationsToLine(el, delAnn.lineIndex);
    }
};

async function addAnnotation(type) {
    if (!pendingAnnot || !currentBookId) { hideAnnotMenu(); return; }
    const { lineIndex, start, end } = pendingAnnot;
    const ann = { id: Date.now(), lineIndex, start, end, type, createdAt: Date.now() };
    currentAnnotations.push(ann);
    await saveAnnotations(currentBookId, currentAnnotations);
    const el = lineElements[lineIndex];
    if (el) applyAnnotationsToLine(el, lineIndex);
    hideAnnotMenu();
    window.getSelection()?.removeAllRanges();
}

document.getElementById('am-copy').onclick = () => {
    if (pendingAnnot) navigator.clipboard.writeText(pendingAnnot.text).catch(() => {});
    hideAnnotMenu();
    window.getSelection()?.removeAllRanges();
};
document.getElementById('am-hl').onclick   = () => addAnnotation('hl');
document.getElementById('am-wave').onclick = () => addAnnotation('wave');
document.getElementById('am-line').onclick = () => addAnnotation('line');
document.getElementById('am-note').onclick = () => {
    if (!pendingAnnot) { hideAnnotMenu(); return; }
    const quoted = `「${pendingAnnot.text}」\n`;
    hideAnnotMenu();
    window.getSelection()?.removeAllRanges();
    notesInput.value = quoted;
    openNotes();
    setTimeout(() => {
        notesInput.focus();
        notesInput.setSelectionRange(quoted.length, quoted.length);
    }, 300);
};

// ── Font panel ──
function openFont()  { fontPanel.classList.add('open'); fontBackdrop.classList.add('open'); }
function closeFont() { fontPanel.classList.remove('open'); fontBackdrop.classList.remove('open'); }

fpSlider.addEventListener('input', () => {
    fontSize = +fpSlider.value;
    fpSizeVal.textContent = fontSize;
    rd.style.fontSize = fontSize + 'px';
    layoutCache = null; // font size change invalidates page map
});

function rebuildFontGrid() {
    const grid = document.getElementById('fp-family-grid');
    grid.querySelectorAll('.fp-ff-btn').forEach(b => b.remove());
    FONT_FAMILIES.forEach(ff => {
        const btn = document.createElement('button');
        btn.className = 'fp-ff-btn';
        btn.textContent = ff.name;
        btn.style.fontFamily = ff.value;
        btn.dataset.value = ff.value;
        if (ff.value === fontFamily) btn.classList.add('active');
        btn.onclick = () => {
            fontFamily = ff.value;
            rd.style.fontFamily = fontFamily;
            layoutCache = null;
            grid.querySelectorAll('.fp-ff-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.value === fontFamily)
            );
        };
        grid.appendChild(btn);
    });
}

// ── Font import ──
const fontFileInput = document.createElement('input');
fontFileInput.type = 'file';
fontFileInput.accept = '.ttf,.woff,.woff2,.otf';
fontFileInput.style.display = 'none';
document.body.appendChild(fontFileInput);

document.getElementById('fp-import-btn').onclick = () => fontFileInput.click();

fontFileInput.onchange = async () => {
    const file = fontFileInput.files[0];
    if (!file) return;
    fontFileInput.value = '';
    const rawName = file.name.replace(/\.[^.]+$/, '');
    const url = URL.createObjectURL(file);
    try {
        const face = new FontFace(rawName, `url(${url})`);
        await face.load();
        document.fonts.add(face);
        const val = `'${rawName}', serif`;
        if (!FONT_FAMILIES.find(f => f.value === val)) {
            FONT_FAMILIES.push({ name: rawName.slice(0, 5), value: val });
        }
        fontFamily = val;
        rd.style.fontFamily = fontFamily;
        layoutCache = null;
        rebuildFontGrid();
    } catch (err) {
        alert('字体加载失败：' + err.message);
        URL.revokeObjectURL(url);
    }
};

document.getElementById('font-close').onclick = closeFont;
fontBackdrop.onclick = closeFont;

// ── Layout / pagination ──
// Each page renders ONLY its own lines — no translateX sliding strip.
// Flow: measure full layout → build pageLineMap → swap DOM content per page.

function buildPageLineMap() {
    const pW = exactPageW || colVp.clientWidth;
    const vpLeft = colVp.getBoundingClientRect().left;
    const byPage = {};
    lineElements.forEach((el, i) => {
        if (!el) return;
        const p = Math.max(0, Math.floor((el.getBoundingClientRect().left - vpLeft) / pW));
        if (!byPage[p]) byPage[p] = [];
        byPage[p].push(i);
    });
    const raw = [];
    for (let p = 0; p < totalPages; p++) raw.push(byPage[p] || []);

    // Merge pages whose lines are all blank into the previous page
    const hasText = lines => lines.some(i => rawLines[i].trim().length > 0);
    const merged = [];
    for (const lines of raw) {
        if (!hasText(lines) && merged.length > 0) {
            merged[merged.length - 1].push(...lines);
        } else {
            merged.push([...lines]);
        }
    }
    pageLineMap = merged;
    totalPages = merged.length;

    lineToPage = new Array(rawLines.length).fill(0);
    pageLineMap.forEach((lines, p) => lines.forEach(i => { lineToPage[i] = p; }));
}

function restoreAllElements() {
    const frag = document.createDocumentFragment();
    lineElements.forEach(el => { if (el) frag.appendChild(el); });
    rd.replaceChildren(frag);
}

function applyColumnsMode() {
    colVp.classList.add('active');
    ct.classList.add('columns-mode');
    const cs = getComputedStyle(ct);
    const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const h = ct.clientHeight - vPad;
    rd.style.height = h + 'px';
    rd.classList.add('columns-mode');

    // Fast path: skip re-measurement if viewport and font haven't changed
    if (layoutCache &&
        layoutCache.bookId === currentBookId &&
        layoutCache.fontSize === fontSize &&
        layoutCache.fontFamily === fontFamily &&
        layoutCache.vpW === colVp.clientWidth &&
        layoutCache.ctH === h) {
        pageLineMap = layoutCache.pageLineMap;
        lineToPage  = layoutCache.lineToPage;
        totalPages  = layoutCache.totalPages;
        exactPageW  = layoutCache.exactPageW;
        goToPage(lineToPage[currentNoteLineIndex] || 0);
        updateTocActiveForPage();
        return;
    }

    // Slow path: full CSS column measurement
    requestAnimationFrame(() => requestAnimationFrame(() => {
        totalPages = Math.max(1, Math.round(rd.scrollWidth / colVp.clientWidth));
        exactPageW = rd.scrollWidth / totalPages;
        buildPageLineMap();
        layoutCache = {
            bookId: currentBookId, fontSize, fontFamily,
            vpW: colVp.clientWidth, ctH: h,
            pageLineMap: pageLineMap.map(a => [...a]),
            lineToPage: [...lineToPage],
            totalPages, exactPageW,
        };
        goToPage(lineToPage[currentNoteLineIndex] || 0);
        updateTocActiveForPage();
    }));
}

function leaveColumnsMode() {
    const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    restoreAllElements();
    colVp.classList.remove('active');
    ct.classList.remove('columns-mode');
    rd.style.height = '';
    rd.classList.remove('columns-mode');
    pageLineMap = []; lineToPage = []; exactPageW = 0;
    currentPage = 0; totalPages = 1;
    requestAnimationFrame(() => { ct.scrollTop = ratio * ct.scrollHeight; });
}

function goToPage(page) {
    currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const frag = document.createDocumentFragment();
    (pageLineMap[currentPage] || []).forEach(i => { if (lineElements[i]) frag.appendChild(lineElements[i]); });
    rd.replaceChildren(frag);
    updatePgInfo();
    updateTocActiveForPage();
}

function scrollToElement(el) {
    if (!el) return;
    let lineEl = el;
    while (lineEl && !lineEl.dataset.line) lineEl = lineEl.parentElement;
    if (lineEl) goToPage(lineToPage[+lineEl.dataset.line] || 0);
}

function scrollToLine(lineIndex) {
    if (layoutMode === 'columns') {
        goToPage(lineToPage[lineIndex] || 0);
    } else {
        const el = lineElements[lineIndex];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function updateTocActiveForPage() {
    if (!tocEntries.length || layoutMode !== 'columns') return;
    let cur = tocEntries[0];
    for (const e of tocEntries) {
        if ((lineToPage[e.lineIndex] || 0) <= currentPage) cur = e;
        else break;
    }
    document.querySelectorAll('.ti.active').forEach(x => x.classList.remove('active'));
    const tiEl = tl.querySelector(`[data-line="${cur.lineIndex}"]`);
    if (tiEl) { tiEl.classList.add('active'); tiEl.scrollIntoView({ block: 'nearest' }); }
    currentNoteChapter = cur.title;
    currentNoteLineIndex = cur.lineIndex;
    debouncedSavePos(cur.lineIndex, cur.title);
}

function setLayoutMode(mode) {
    layoutMode = mode;
    if (mode === 'columns') {
        if (rd.style.display !== 'none') applyColumnsMode();
    } else {
        leaveColumnsMode();
    }
    pgNav.classList.toggle('visible', mode === 'columns');
    document.getElementById('sb-layout').classList.toggle('active', mode === 'columns');
    document.getElementById('sb-layout').title = mode === 'columns' ? '单栏阅读' : '双栏阅读';
}

window.addEventListener('resize', debounce(() => {
    layoutCache = null; // viewport changed, invalidate cache
    if (layoutMode !== 'columns') return;
    const savedPage = currentPage;
    restoreAllElements();
    const cs = getComputedStyle(ct);
    const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    rd.style.height = (ct.clientHeight - vPad) + 'px';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        totalPages = Math.max(1, Math.round(rd.scrollWidth / colVp.clientWidth));
        exactPageW = rd.scrollWidth / totalPages;
        buildPageLineMap();
        layoutCache = {
            bookId: currentBookId, fontSize, fontFamily,
            vpW: colVp.clientWidth, ctH: ct.clientHeight - vPad,
            pageLineMap: pageLineMap.map(a => [...a]),
            lineToPage: [...lineToPage],
            totalPages, exactPageW,
        };
        goToPage(Math.min(savedPage, totalPages - 1));
    }));
}, 200));

document.getElementById('pg-prev').onclick = () => goToPage(currentPage - 1);
document.getElementById('pg-next').onclick = () => goToPage(currentPage + 1);

// ── Side buttons wiring ──
document.getElementById('sb-toc').onclick = () =>
    tocPanel.classList.contains('open') ? closeToc() : openToc();
document.getElementById('sb-notes').onclick = () =>
    notesPanel.classList.contains('open') ? closeNotes() : openNotes();
document.getElementById('sb-layout').onclick = () =>
    setLayoutMode(layoutMode === 'scroll' ? 'columns' : 'scroll');
document.getElementById('sb-font').onclick = () =>
    fontPanel.classList.contains('open') ? closeFont() : openFont();
document.getElementById('sb-theme').onclick = () => {
    dark = !dark;
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    const btn = document.getElementById('sb-theme');
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark ? '浅色模式' : '深色模式';
};

// ── showState ──
function showState(s) {
    wl.style.display      = s === 'welcome' ? 'flex'  : 'none';
    ld.style.display      = s === 'loading' ? 'flex'  : 'none';
    rd.style.display      = s === 'reader'  ? 'block' : 'none';
    shelfEl.style.display = s === 'shelf'   ? 'block' : 'none';
    sideBtns.classList.toggle('visible', s === 'reader');
    if (s !== 'reader') { hidePanel(); closeNotes(); closeFont(); closeToc(); }
}

// ── Shelf ──
const BOOK_ICONS = { txt: '📄', pdf: '📕', epub: '📗' };

function renderShelf(books) {
    const frag = document.createDocumentFragment();

    books.forEach(book => {
        const card = document.createElement('div');
        card.className = 'bc';

        const lastDate = book.lastOpenedAt
            ? new Date(book.lastOpenedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
            : '';
        const lastInfo = book.lastChapter
            ? `${lastDate} · ${book.lastChapter}`.slice(0, 28)
            : lastDate;

        card.innerHTML =
            `<div class="bc-icon">${BOOK_ICONS[book.type] || '📖'}</div>` +
            `<div class="bc-name" title="${esc(book.name)}">${esc(book.name)}</div>` +
            `<div class="bc-type">${book.type.toUpperCase()}</div>` +
            `<div class="bc-last">${esc(lastInfo)}</div>` +
            `<button class="bc-del" title="从书架删除">✕</button>`;

        card.onclick = () => openBookFromShelf(book);
        card.querySelector('.bc-del').onclick = e => {
            e.stopPropagation();
            if (confirm(`从书架中删除《${book.name}》？`)) {
                deleteBook(book.id).then(goToShelf);
            }
        };
        frag.appendChild(card);
    });

    const addCard = document.createElement('div');
    addCard.className = 'bc bc-add';
    addCard.innerHTML = '<div class="plus">＋</div><div>添加书籍</div>';
    addCard.onclick = () => fi.click();
    frag.appendChild(addCard);

    shelfGrid.innerHTML = '';
    shelfGrid.appendChild(frag);
}

async function goToShelf() {
    currentBookId = null;
    tl.innerHTML = '<div style="padding:10px 14px;color:var(--muted);font-size:12px;">请在书架中选择书籍</div>';
    const books = await loadBooks();
    renderShelf(books);
    showState('shelf');
}

async function openBookFromShelf(book) {
    currentBookId = book.id;
    showState('loading');
    await render(book.content);
    document.title = book.name + ' — 简单阅读器';
    currentAnnotations = await getAnnotations(book.id);
    applyAnnotations();
    if (book.lastLine > 0) {
        // Columns mode applies asynchronously (double-RAF); use longer delay
        setTimeout(() => scrollToLine(book.lastLine), layoutMode === 'columns' ? 250 : 80);
    }
    savePosition(book.id, book.lastLine || 0, book.lastChapter || '');
}

document.getElementById('btn-shelf').onclick = goToShelf;

// ── Help modal ──
const HELP_TEXT = `<b>【一、导入书籍】</b>
支持格式：TXT（UTF-8）· PDF · EPUB
点击顶部「导入文件」或直接拖入阅读区域。
导入后自动保存到书架，下次无需重新导入。

<b>【二、书架】</b>
点击书卡打开书籍，自动恢复上次阅读位置。
悬停书卡后点击右上角「✕」删除书籍。

<b>【三、目录导航】</b>
自动识别章节标记：【卷X·章节名】、◎小节名、第X章/节/卷/篇/回、Chapter N 等。
点击右侧悬浮「☰」打开目录，阅读时自动高亮当前章节。

<b>【四、全文检索】</b>
顶部搜索框输入关键词，结果按章节分组显示上下文。
点击条目跳转，「◀ N/M ▶」可逐条翻阅。
快捷键：Ctrl+F 打开/关闭 · Enter 下一处 · Shift+Enter 上一处 · Escape 关闭

<b>【五、右侧悬浮按钮】</b>
☰ 目录 · ✏ 笔记 · ⊞ 版式（单栏/双栏）· A 字体 · 🌙 主题
双栏模式下底部出现翻页按钮，也可用左右方向键翻页。

<b>【六、阅读位置自动保存】</b>
滚动停止约 1 秒后自动保存位置，下次打开书卡即恢复。`;

(function () {
    const backdrop = document.getElementById('help-backdrop');
    const modal    = document.getElementById('help-modal');
    const body     = document.getElementById('help-body');
    body.innerHTML = HELP_TEXT.replace(/\n/g, '<br>');
    const open  = () => { backdrop.classList.add('open'); modal.classList.add('open'); };
    const close = () => { backdrop.classList.remove('open'); modal.classList.remove('open'); };
    document.getElementById('btn-help').onclick = open;
    document.getElementById('help-close').onclick = close;
    backdrop.onclick = close;
})();

// ── Startup ──
rebuildFontGrid();
(async () => { await goToShelf(); })();
