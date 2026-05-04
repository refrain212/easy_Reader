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
let tocEditMode = false;
let tocEntriesBeforeEdit = [];
let pendingAnnot = null;
let annotCtxAid  = null;
let lastColorIdx     = 0;
let pendingAnnotType = null;
let autoMatchEnabled = false;
let _aidCtr = Date.now();
function genAid() { return _aidCtr++; }

const ANNOT_COLORS = [
    { dot: '#f9ca24', hl: '#fff3a0', dec: '#9a7e00' },
    { dot: '#ff6b81', hl: '#ffc0c8', dec: '#c52040' },
    { dot: '#a29bfe', hl: '#d8d0ff', dec: '#5040b0' },
    { dot: '#74b9ff', hl: '#c0dcff', dec: '#1850a0' },
    { dot: '#55efc4', hl: '#b0f8e8', dec: '#007858' },
    { dot: '#fd9644', hl: '#ffd4a0', dec: '#a05820' },
];

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

async function getCustomToc(bookId) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(bookId);
        req.onsuccess = e => res(e.target.result?.customToc ?? null);
        req.onerror   = rej;
    });
}

async function saveCustomToc(bookId, toc) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const req = store.get(bookId);
        req.onsuccess = e => {
            if (!e.target.result) { res(); return; }
            store.put({ ...e.target.result, customToc: toc }).onsuccess = res;
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
        const ct0 = await getCustomToc(currentBookId);
        if (ct0 !== null) { tocEntries = ct0; renderToc(); }
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
        tl.innerHTML = '<div style="padding:10px 14px;color:var(--muted);font-size:12px;">' +
            (tocEditMode ? '暂无条目，请在下方添加' : '未检测到目录结构') + '</div>';
        return;
    }
    const frag = document.createDocumentFragment();
    tocEntries.forEach((e, idx) => {
        const d = document.createElement('div');
        d.className = 'ti l' + e.level;
        d.title = e.title;
        d.dataset.line = e.lineIndex;
        d.appendChild(document.createTextNode(e.title));
        d.onclick = () => {
            if (!tocEditMode) { closeToc(); scrollToLine(e.lineIndex); }
        };
        if (tocEditMode) {
            const del = document.createElement('button');
            del.className = 'ti-del';
            del.textContent = '✕';
            del.title = '删除此条目';
            del.onclick = ev => {
                ev.stopPropagation();
                tocEntries = tocEntries.filter((_, i) => i !== idx);
                renderToc();
            };
            d.appendChild(del);
        }
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
        else {
            si.focus(); si.select(); showPanel();
            if (!results.length) {
                rpCnt.textContent = '';
                rpBd.innerHTML = '<p style="padding:24px 0;color:var(--muted);text-align:center;font-size:14px">请在上方搜索框输入关键词</p>';
            }
        }
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
function closeToc() {
    if (tocEditMode) exitTocEditMode(false); // discard unsaved changes
    tocPanel.classList.remove('open'); tocBackdrop.classList.remove('open');
}

// ── TOC editor ──
function enterTocEditMode() {
    if (!currentBookId) return;
    tocEntriesBeforeEdit = tocEntries.map(e => ({ ...e }));
    tocEditMode = true;
    tocPanel.classList.add('edit-mode');
    // Update position input placeholder based on current layout
    document.getElementById('teb-pos').placeholder = layoutMode === 'columns' ? '页码' : '行号';
    renderToc();
}

function exitTocEditMode(save) {
    tocEditMode = false;
    tocPanel.classList.remove('edit-mode');
    if (save) {
        saveCustomToc(currentBookId, tocEntries.map(e => ({ ...e })));
    } else {
        tocEntries = tocEntriesBeforeEdit;
        renderToc();
    }
    tocEntriesBeforeEdit = [];
}

document.getElementById('toc-edit-btn').onclick = () => {
    if (tocEditMode) exitTocEditMode(true);
    else enterTocEditMode();
};

document.getElementById('teb-cur').onclick = () => {
    const inp = document.getElementById('teb-pos');
    if (layoutMode === 'columns') {
        inp.placeholder = '页码';
        inp.value = currentPage + 1;
    } else {
        inp.placeholder = '行号';
        inp.value = currentNoteLineIndex + 1;
    }
};

document.getElementById('teb-add').onclick = () => {
    const title = document.getElementById('teb-title').value.trim();
    const pos   = parseInt(document.getElementById('teb-pos').value, 10);
    const level = parseInt(document.getElementById('teb-level').value, 10);
    if (!title || isNaN(pos) || pos < 1) return;
    let lineIndex;
    if (layoutMode === 'columns') {
        const page = Math.max(0, Math.min(pos - 1, totalPages - 1));
        lineIndex = pageLineMap[page]?.[0] ?? 0;
    } else {
        lineIndex = Math.max(0, Math.min(pos - 1, rawLines.length - 1));
    }
    tocEntries = [...tocEntries, { level, title, lineIndex }];
    tocEntries.sort((a, b) => a.lineIndex - b.lineIndex);
    document.getElementById('teb-title').value = '';
    document.getElementById('teb-pos').value   = '';
    renderToc();
};

document.getElementById('teb-reset').onclick = async () => {
    if (!currentBookId) return;
    tocEntries = detectToc(rawLines);
    await saveCustomToc(currentBookId, null);
    exitTocEditMode(false);
};

document.getElementById('teb-done').onclick = () => exitTocEditMode(true);
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

function combineAnnotStyles(anns) {
    const dark = document.documentElement.dataset.theme === 'dark';
    const parts = [], decorParts = [];
    let hasLine = false;
    for (const a of anns) {
        const c = ANNOT_COLORS[a.colorIdx ?? 0];
        if (a.type === 'hl')   parts.push(`background:${dark ? c.dec : c.hl}`);
        if (a.type === 'wave') decorParts.push(`underline wavy ${c.dec}`);
        if (a.type === 'line') { decorParts.push(`underline ${c.dec}`); hasLine = true; }
    }
    if (decorParts.length) parts.push(`text-decoration:${decorParts.join(',')}`);
    if (hasLine) parts.push('text-underline-offset:2px');
    return parts.join(';');
}

function findAllOccurrences(text) {
    const results = [];
    for (let li = 0; li < rawLines.length; li++) {
        const line = rawLines[li];
        let pos = 0;
        while (pos < line.length) {
            const idx = line.indexOf(text, pos);
            if (idx === -1) break;
            results.push({ lineIndex: li, start: idx, end: idx + text.length });
            pos = idx + 1;
        }
    }
    return results;
}

function applyAnnotationsToLine(el, lineIndex) {
    const anns = currentAnnotations.filter(a => a.lineIndex === lineIndex);
    if (!anns.length) {
        if (el.querySelector('[data-aid]')) el.textContent = rawLines[lineIndex];
        return;
    }
    const text = rawLines[lineIndex];
    // Collect all boundary points then render each segment with merged styles
    const pts = new Set([0, text.length]);
    anns.forEach(a => { pts.add(Math.max(0, a.start)); pts.add(Math.min(text.length, a.end)); });
    const sorted = [...pts].sort((a, b) => a - b);
    let html = '';
    for (let i = 0; i < sorted.length - 1; i++) {
        const s = sorted[i], e = sorted[i + 1];
        if (s >= e) continue;
        const covering = anns.filter(a => a.start <= s && a.end >= e);
        if (!covering.length) {
            html += esc(text.slice(s, e));
        } else {
            const style = combineAnnotStyles(covering);
            const aids  = covering.map(a => a.id).join(',');
            html += `<span class="annot-seg" data-aid="${aids}" style="${style}">${esc(text.slice(s, e))}</span>`;
        }
    }
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
const annotMenu  = document.getElementById('annot-menu');
const annotCtxEl = document.getElementById('annot-ctx');
const acpEl      = document.getElementById('acp');
const acpMatchCb = document.getElementById('acp-match-cb');

function showAmTypes() {
    document.querySelector('.am-types').style.display = '';
    acpEl.style.display = 'none';
    pendingAnnotType = null;
}

function openColorPicker(type) {
    pendingAnnotType = type;
    document.querySelector('.am-types').style.display = 'none';
    acpEl.style.display = 'flex';
    document.querySelectorAll('.acp-dot').forEach((d, i) =>
        d.classList.toggle('active', i === lastColorIdx));
}

function positionAnnotMenu(selRect) {
    const mh = annotMenu.offsetHeight;
    const mw = annotMenu.offsetWidth;
    let cx = selRect.left + selRect.width / 2;
    let top = selRect.top - mh - 10;
    if (cx - mw / 2 < 8)                       cx = mw / 2 + 8;
    if (cx + mw / 2 > window.innerWidth - 8)    cx = window.innerWidth - mw / 2 - 8;
    if (top < 6) top = selRect.bottom + 10;
    annotMenu.style.left = cx + 'px';
    annotMenu.style.top  = top + 'px';
}

function showAnnotMenu(rect, lineIndex, start, end, text) {
    pendingAnnot = { lineIndex, start, end, text };
    showAmTypes();
    annotMenu.style.left = '-9999px';
    annotMenu.classList.add('visible');
    requestAnimationFrame(() => positionAnnotMenu(rect));
}

function hideAnnotMenu() {
    annotMenu.classList.remove('visible');
    pendingAnnot = null;
    showAmTypes();
    if (CSS.highlights) CSS.highlights.delete('annot-sel');
}

function hideAnnotCtx() {
    annotCtxEl.classList.remove('visible');
    annotCtxAid = null;
}

// Build color dots once
(function buildColorDots() {
    const container = document.getElementById('acp-dots');
    ANNOT_COLORS.forEach((c, i) => {
        const dot = document.createElement('button');
        dot.className = 'acp-dot' + (i === lastColorIdx ? ' active' : '');
        dot.style.background = c.dot;
        dot.textContent = '✓';
        dot.title = '';
        dot.onclick = () => {
            lastColorIdx = i;
            document.querySelectorAll('.acp-dot').forEach((d, j) =>
                d.classList.toggle('active', j === i));
            addAnnotation(pendingAnnotType, i);
        };
        container.appendChild(dot);
    });
})();

acpMatchCb.checked = autoMatchEnabled;
acpMatchCb.onchange = () => { autoMatchEnabled = acpMatchCb.checked; };

document.getElementById('acp-back').onclick = () => showAmTypes();

document.addEventListener('mousedown', e => {
    if (!annotMenu.contains(e.target))  hideAnnotMenu();
    if (!annotCtxEl.contains(e.target)) hideAnnotCtx();
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
    const rect = range.getBoundingClientRect();
    if (CSS.highlights) {
        CSS.highlights.set('annot-sel', new Highlight(range.cloneRange()));
    }
    sel.removeAllRanges();
    showAnnotMenu(rect, lineIndex, start, end, selText);
});

rd.addEventListener('contextmenu', e => {
    e.preventDefault();
    const span = e.target.closest('[data-aid]');
    if (!span) return;
    hideAnnotMenu();
    const aids = span.dataset.aid.split(',').map(Number);
    const anns = aids.map(id => currentAnnotations.find(a => a.id === id)).filter(Boolean);
    if (!anns.length) return;
    const typeLabel = { hl: '马克笔', wave: '波浪线', line: '直线' };
    annotCtxEl.innerHTML = '';
    anns.forEach(ann => {
        const btn = document.createElement('button');
        btn.className = 'annot-ctx-item';
        btn.textContent = `删除 ${typeLabel[ann.type] || ann.type}`;
        btn.onclick = () => { hideAnnotCtx(); deleteAnnotation(ann.id); };
        annotCtxEl.appendChild(btn);
    });
    annotCtxEl.style.left = e.clientX + 'px';
    annotCtxEl.style.top  = e.clientY + 'px';
    annotCtxEl.classList.add('visible');
});

async function deleteAnnotation(aid) {
    const delAnn = currentAnnotations.find(a => a.id === aid);
    if (!delAnn || !currentBookId) return;
    let affectedLines;
    if (delAnn.groupId != null) {
        const grp = currentAnnotations.filter(a => a.groupId === delAnn.groupId);
        affectedLines = new Set(grp.map(a => a.lineIndex));
        currentAnnotations = currentAnnotations.filter(a => a.groupId !== delAnn.groupId);
    } else {
        affectedLines = new Set([delAnn.lineIndex]);
        currentAnnotations = currentAnnotations.filter(a => a.id !== aid);
    }
    await saveAnnotations(currentBookId, currentAnnotations);
    affectedLines.forEach(li => { const el = lineElements[li]; if (el) applyAnnotationsToLine(el, li); });
}

async function addAnnotation(type, colorIdx) {
    if (!pendingAnnot || !currentBookId) { hideAnnotMenu(); return; }
    const { lineIndex, start, end, text } = pendingAnnot;
    const gid = autoMatchEnabled ? genAid() : null;
    const newAnns = [{
        id: genAid(), lineIndex, start, end, type, colorIdx,
        createdAt: Date.now(), groupId: gid, matchText: autoMatchEnabled ? text : null,
    }];
    if (autoMatchEnabled && text.length > 0) {
        let matched = 0;
        for (const occ of findAllOccurrences(text)) {
            if (occ.lineIndex === lineIndex && occ.start === start) continue;
            const dup = currentAnnotations.some(a =>
                a.lineIndex === occ.lineIndex && a.start === occ.start &&
                a.end === occ.end && a.type === type);
            if (dup) continue;
            newAnns.push({ id: genAid(), lineIndex: occ.lineIndex, start: occ.start,
                end: occ.end, type, colorIdx, createdAt: Date.now(), groupId: gid, matchText: text });
            if (++matched >= 200) break;
        }
    }
    currentAnnotations.push(...newAnns);
    await saveAnnotations(currentBookId, currentAnnotations);
    const affected = new Set(newAnns.map(a => a.lineIndex));
    affected.forEach(li => { const el = lineElements[li]; if (el) applyAnnotationsToLine(el, li); });
    hideAnnotMenu();
    window.getSelection()?.removeAllRanges();
}

document.getElementById('am-copy').onclick = () => {
    if (pendingAnnot) navigator.clipboard.writeText(pendingAnnot.text).catch(() => {});
    hideAnnotMenu();
    window.getSelection()?.removeAllRanges();
};
document.getElementById('am-hl').onclick   = () => openColorPicker('hl');
document.getElementById('am-wave').onclick = () => openColorPicker('wave');
document.getElementById('am-line').onclick = () => openColorPicker('line');
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
    layoutCache = null;
    if (layoutMode === 'columns') applyColumnsMode();
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
            if (layoutMode === 'columns') applyColumnsMode();
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
        if (layoutMode === 'columns') applyColumnsMode();
    } catch (err) {
        alert('字体加载失败：' + err.message);
        URL.revokeObjectURL(url);
    }
};

document.getElementById('font-close').onclick = closeFont;
fontBackdrop.onclick = closeFont;

// ── Layout / pagination ──
// Height-based pagination: measure each element's offsetHeight at column width,
// then greedily fill col-A → col-B → new page. goToPage swaps DOM content per page.

function buildPageLineMap() {
    const h = parseFloat(rd.style.height);
    if (isNaN(h) || h <= 0) return;

    // Read column gap while columns-mode is active, then temporarily switch to flat layout
    const gap = parseFloat(getComputedStyle(rd).columnGap) || 0;
    const colW = Math.floor((colVp.clientWidth - gap) / 2);

    rd.classList.remove('columns-mode');
    rd.style.width    = colW + 'px';
    rd.style.maxWidth = 'none';

    // Greedy two-column fill
    const pages = [];
    let page = [], colIdx = 0, colH = 0;
    lineElements.forEach((el, i) => {
        if (!el) return;
        const elH = el.offsetHeight;
        if (colH > 0 && colH + elH > h) {
            if (colIdx === 0) { colIdx = 1; colH = 0; }
            else { pages.push([...page]); page = []; colIdx = 0; colH = 0; }
        }
        page.push(i);
        colH += elH;
    });
    if (page.length) pages.push(page);

    rd.style.width    = '';
    rd.style.maxWidth = '';
    rd.classList.add('columns-mode');

    // Merge blank-only pages into the previous page
    const hasText = ls => ls.some(i => rawLines[i]?.trim().length > 0);
    const merged = [];
    for (const p of pages) {
        if (!hasText(p) && merged.length > 0) merged[merged.length - 1].push(...p);
        else merged.push([...p]);
    }

    pageLineMap = merged;
    totalPages  = merged.length || 1;
    lineToPage  = new Array(rawLines.length).fill(0);
    pageLineMap.forEach((ls, p) => ls.forEach(i => { lineToPage[i] = p; }));
}

function restoreAllElements() {
    const frag = document.createDocumentFragment();
    lineElements.forEach(el => { if (el) frag.appendChild(el); });
    rd.replaceChildren(frag);
    rd.style.transform = '';
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

    // Slow path: height-based measurement
    requestAnimationFrame(() => requestAnimationFrame(() => {
        restoreAllElements();              // ensure all elements are in rd
        exactPageW = colVp.clientWidth;
        buildPageLineMap();
        totalPages = pageLineMap.length;
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
        exactPageW = colVp.clientWidth;
        buildPageLineMap();
        totalPages = pageLineMap.length;
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
    if (currentAnnotations.length) applyAnnotations();
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
    const ct1 = await getCustomToc(book.id);
    if (ct1 !== null) { tocEntries = ct1; renderToc(); }
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
