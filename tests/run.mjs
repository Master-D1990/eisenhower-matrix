#!/usr/bin/env node
// Browser tests for Eisenhower Matrix+.
// No dependencies: Node 22+ (built-in WebSocket and fetch) and Chrome or Chromium.
// Run: node tests/run.mjs        (CHROME=/path/to/chrome to pick a browser, KEEP=1 to keep the profile)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- static server for the repository ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
function startServer() {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* ---------- Chrome + CDP ---------- */
const CANDIDATES = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
async function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-test-'));
  const args = ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--lang=de-CH', 'about:blank'];
  if (process.env.CI) args.unshift('--no-sandbox');
  for (const bin of CANDIDATES) {
    const proc = spawn(bin, args, { stdio: 'ignore' });
    const ok = await new Promise(r => { proc.once('error', () => r(false)); setTimeout(() => r(true), 300); });
    if (!ok) continue;
    const portFile = path.join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    if (!fs.existsSync(portFile)) { proc.kill(); continue; }
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    return { proc, dir, url: `ws://127.0.0.1:${port}${wsPath}` };
  }
  throw new Error('Chrome/Chromium not found. Set CHROME=/path/to/chrome');
}
class Browser {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const b = new Browser(ws);
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id && b.pending.has(d.id)) { const { r, j } = b.pending.get(d.id); b.pending.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result); }
      else if (d.sessionId && b.handlers.has(d.sessionId)) b.handlers.get(d.sessionId)(d);
    };
    return b;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((r, j) => this.pending.set(id, { r, j }));
  }
  // every page gets its own browser context = its own empty localStorage / IndexedDB
  async page({ width = 1440, height = 860, mobile = false, init = '' } = {}) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(this, sessionId, browserContextId);
    this.handlers.set(sessionId, d => p.onEvent(d));
    await p.send('Runtime.enable'); await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await p.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    if (init) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
    return p;
  }
}
class Page {
  constructor(b, sessionId, ctx) { this.b = b; this.sessionId = sessionId; this.ctx = ctx; this.errors = []; this.loaded = null; }
  send(m, p) { return this.b.send(m, p, this.sessionId); }
  onEvent(d) {
    if (d.method === 'Runtime.exceptionThrown') this.errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
    if (d.method === 'Page.loadEventFired' && this.loaded) { this.loaded(); this.loaded = null; }
  }
  async goto(url) { const done = new Promise(r => this.loaded = r); await this.send('Page.navigate', { url }); await done; await sleep(300); }
  async reload() { const done = new Promise(r => this.loaded = r); await this.send('Page.reload'); await done; await sleep(300); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('in page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async close() { await this.b.send('Target.disposeBrowserContext', { browserContextId: this.ctx }); }
}

/* ---------- tiny test runner ---------- */
const results = [];
let current = null;
function check(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { check(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`); }
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`  ✗ ${name}\n      ${e.message}`); }
  finally { if (current) { await current.close().catch(() => {}); current = null; } }
}
async function open(browser, base, opts = {}) {
  current = await browser.page(opts);
  await current.goto(base + (opts.query ?? '?nohelp'));
  await current.ev(`setLang('${opts.lang || 'de'}')`);
  return current;
}
function noErrors(p) { check(p.errors.length === 0, 'console errors: ' + p.errors.join(' | ')); }

/* ---------- in-page helpers ---------- */
// desktop: both arrow lines start in the same point, the heads end at the matrix edges
const MEASURE_DESKTOP = `(()=>{
  const r=e=>e.getBoundingClientRect();
  const ya=document.querySelector('.ax-arrow.y'), xa=document.querySelector('.ax-arrow.x');
  const yl=r(ya.querySelector('.ln')), yh=r(ya.querySelector('.hd')), xl=r(xa.querySelector('.ln')), xh=r(xa.querySelector('.hd'));
  const cells=[...document.querySelectorAll('#board .cell')].map(r);
  const top=Math.min(...cells.map(c=>c.top)), bottom=Math.max(...cells.map(c=>c.bottom)), left=Math.min(...cells.map(c=>c.left)), right=Math.max(...cells.map(c=>c.right));
  const down=ya.classList.contains('down'), toLeft=xa.classList.contains('left');
  return {yX:yl.left+yl.width/2, xY:xl.top+xl.height/2,
    yOriginY:down?yl.top:yl.bottom, xOriginX:toLeft?xl.right:xl.left,
    yTip:down?yh.bottom:yh.top, xTip:toLeft?xh.left:xh.right,
    edgeY:down?bottom:top, edgeX:toLeft?left:right};
})()`;
// phone: same idea for the pad below the list
const MEASURE_PAD = `(()=>{
  const pe=(el,p)=>{const cs=getComputedStyle(el,p),b=el.getBoundingClientRect();return {l:b.left+parseFloat(cs.left),t:b.top+parseFloat(cs.top),w:parseFloat(cs.width),h:parseFloat(cs.height)}};
  const y=pe(document.querySelector('.pad-arrow.y'),'::before'), x=pe(document.querySelector('.pad-arrow.x'),'::before');
  const pad=document.querySelector('#mobilePad').getBoundingClientRect();
  const ty=document.querySelector('.pad-title.y').getBoundingClientRect(), tx=document.querySelector('.pad-title.x').getBoundingClientRect();
  return {yX:y.l+y.w/2, xStartX:state.flipX?x.l+x.w:x.l, xY:x.t+x.h/2, yEndY:state.flipY?y.t:y.t+y.h,
    tyMid:ty.top+ty.height/2, padMidY:(pad.top+pad.bottom)/2, txMid:tx.left+tx.width/2, padMidX:(pad.left+pad.right)/2};
})()`;
// Google Identity Services + Drive REST, emulated in memory (injected before the page scripts run)
const DRIVE_MOCK = `
// the emulated Drive survives a page reload (kept in sessionStorage)
window.__drive=JSON.parse(sessionStorage.getItem('__drive')||'null')||{files:[],ver:0};
Object.assign(window.__drive,{offline:false,revoked:false,confirms:0});
const __keep=()=>sessionStorage.setItem('__drive',JSON.stringify(window.__drive));
addEventListener('pagehide',__keep);
window.google={accounts:{oauth2:{
  initTokenClient:cfg=>({requestAccessToken:()=>setTimeout(()=>cfg.callback({access_token:'tok',expires_in:3600}),0)}),
  initCodeClient:cfg=>({requestCode:()=>setTimeout(()=>cfg.callback({code:'code1'}),0)}),
  revoke:()=>{window.__drive.revoked=true;}
}}};
window.confirm=()=>{window.__drive.confirms++;return true;};
(()=>{const real=window.fetch.bind(window);
const j=(o,s)=>new Response(JSON.stringify(o),{status:s||200,headers:{'Content-Type':'application/json'}});
const meta=f=>({id:f.id,name:f.name,version:f.version,modifiedTime:f.modifiedTime});
window.fetch=async(url,opts={})=>{
  url=String(url);
  const D=window.__drive;
  // token helper (Cloudflare worker): code -> lasting connection, refresh -> new access token
  if(/\\/(token|refresh)$/.test(url)&&!url.startsWith(location.origin)){
    if(D.offline) throw new TypeError('Failed to fetch');
    D.helperCalls=(D.helperCalls||0)+1;
    return j({access_token:'tok'+D.helperCalls,expires_in:3600,refresh_token:url.endsWith('/token')?'rt1':undefined});
  }
  if(url.includes('oauth2.googleapis.com/revoke')) return new Response('');
  if(!url.includes('googleapis.com')) return real(url,opts);
  if(D.offline) throw new TypeError('Failed to fetch');
  const method=(opts.method||'GET').toUpperCase(), m=url.match(/files\\/([^?]+)/), id=m&&m[1];
  const f=id&&D.files.find(x=>x.id===id);
  if(url.includes('/upload/')){
    if(method==='POST'){const b=String(opts.body),s=b.indexOf('\\r\\n\\r\\n',b.indexOf('\\r\\n\\r\\n')+4)+4,e=b.lastIndexOf('\\r\\n--');
      const nf={id:'f'+(++D.ver),name:'Eisenhower Matrix.matrix.json',version:String(D.ver),modifiedTime:new Date().toISOString(),content:b.slice(s,e)};
      D.files.push(nf); return j(meta(nf));}
    if(!f) return j({},404);
    f.content=String(opts.body); f.version=String(++D.ver); f.modifiedTime=new Date().toISOString(); return j(meta(f));
  }
  if(id){ if(!f) return j({},404); return /alt=media/.test(url)?new Response(f.content):j(meta(f)); }
  return j({files:D.files.map(meta)});
};})();`;

/* ---------- the tests ---------- */
async function main() {
  const srv = await startServer();
  const base = `http://localhost:${srv.address().port}/`;   // localhost: Drive is only offered on https or localhost
  const chrome = await launchChrome();
  const browser = await Browser.connect(chrome.url);
  console.log('Eisenhower Matrix+ tests');

  await test('loads without errors (de and en)', async () => {
    const p = await open(browser, base);
    check(await p.ev(`document.querySelectorAll('#board .cell').length`) === 9, '3x3 example expected');
    await p.ev(`setLang('en')`);
    check(await p.ev(`document.querySelector('#helpList').textContent.length>0`), 'help text');
    noErrors(p);
  });

  await test('desktop axes: common origin, heads at the matrix edges (4 directions x swap)', async () => {
    const p = await open(browser, base);
    for (const swapped of [false, true]) {
      if (swapped) await p.ev(`swapAxes()`);
      for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        await p.ev(`state.flipX=${!!fx};state.flipY=${!!fy};renderBoard()`);
        const m = await p.ev(MEASURE_DESKTOP), tag = `swap=${swapped} fx=${fx} fy=${fy}`;
        near(m.yOriginY, m.xY, 2, `${tag} vertical arrow starts at the horizontal one`);
        near(m.xOriginX, m.yX, 2, `${tag} horizontal arrow starts at the vertical one`);
        near(m.yTip, m.edgeY, 1.5, `${tag} vertical head at the matrix edge`);
        near(m.xTip, m.edgeX, 1.5, `${tag} horizontal head at the matrix edge`);
      }
    }
    noErrors(p);
  });

  await test('phone axes: common origin, titles centred (4 directions)', async () => {
    const p = await open(browser, base, { width: 390, height: 844, mobile: true });
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      await p.ev(`state.flipX=${!!fx};state.flipY=${!!fy};renderMobile()`);
      const m = await p.ev(MEASURE_PAD), tag = `fx=${fx} fy=${fy}`;
      near(m.yX, m.xStartX, 1.5, `${tag} origin x`);
      near(m.yEndY, m.xY, 1.5, `${tag} origin y`);
      near(m.tyMid, m.padMidY, 1.5, `${tag} vertical title centred`);
      near(m.txMid, m.padMidX, 1.5, `${tag} horizontal title centred`);
    }
    noErrors(p);
  });

  await test('swap twice restores the state, swap and resize do not mark tasks as edited', async () => {
    const p = await open(browser, base);
    await p.ev(`addTask('stamp',[0,0])`);   // leaves the example, every task gets its position
    const r = await p.ev(`(()=>{const mods=()=>JSON.stringify(state.tasks.map(t=>t.mod)), m0=mods(), a=JSON.stringify(state);
      swapAxes(); const m1=mods(); swapAxes(); const same=a===JSON.stringify(state);
      resizeMatrix(4,4); const m2=mods(); resizeMatrix(3,3); flipAxis('x'); flipAxis('x');
      return {same, swapMod:m1===m0, resizeMod:m2===m0, flipMod:mods()===m0};})()`);
    check(r.same, 'state differs after swapping twice');
    check(r.swapMod && r.resizeMod && r.flipMod, 'structural change stamped tasks as edited: ' + JSON.stringify(r));
  });

  await test('phone: sort inside a field by long press and drag', async () => {
    const p = await open(browser, base, { width: 390, height: 844, mobile: true });
    await p.ev(`addTask('one',[0,2]);addTask('two',[0,2]);addTask('three',[0,2]);setMobileSel('0,2')`); await sleep(100);
    const titles = () => p.ev(`[...document.querySelectorAll('#mobileCellList .task-card')].map(c=>findTask(c.dataset.task).title)`);
    const t0 = await titles();
    const box = n => p.ev(`(()=>{const r=document.querySelectorAll('#mobileCellList .task-card')[${n}].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,h:r.height};})()`);
    const touch = (type, x, y) => p.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const drag = async (from, toY) => {
      await touch('touchStart', from.x, from.y); await sleep(550);          // long press
      for (let i = 1; i <= 6; i++) { await touch('touchMove', from.x, from.y + (toY - from.y) * i / 6); await sleep(30); }
      await touch('touchEnd'); await sleep(200);
    };
    const last = await box(t0.length - 1), first = await box(0);
    await drag(last, first.y - first.h * 0.3);                              // last card to the top
    const t1 = await titles();
    check(t1[0] === t0[t0.length - 1] && t1.length === t0.length, 'last card moved to the top: ' + t1.join(', '));
    const u = await p.ev(`undoStack.length`);
    const b0 = await box(0); await drag(b0, b0.y + 2);                      // dropped in place: nothing changes
    check(JSON.stringify(await titles()) === JSON.stringify(t1) && await p.ev(`undoStack.length`) === u, 'drop in place is no change');
    await p.ev(`undo()`);
    check(JSON.stringify(await titles()) === JSON.stringify(t0), 'undo restores the order');
    noErrors(p);
  });

  await test('task detail: done check next to the title, undo from the message', async () => {
    for (const phone of [false, true]) {
      const p = await open(browser, base, phone ? { width: 390, height: 844, mobile: true } : {});
      const id = await p.ev(`(addTask('finish me',[0,0]), state.tasks.find(t=>t.title==='finish me').id)`);
      await p.ev(`openDetail('${id}')`); await sleep(150);
      const r = await p.ev(`(()=>{const b=document.querySelector('#detailDone').getBoundingClientRect(),i=document.querySelector('#dTitle').getBoundingClientRect();
        return {left:b.right<=i.left+1, row:Math.abs((b.top+b.bottom)/2-(i.top+i.bottom)/2)<3, visible:b.width>0,
          noFooterDone:!document.querySelector('.drawer-actions #detailDone')};})()`);
      check(r.left && r.row && r.visible && r.noFooterDone, `${phone ? 'phone' : 'desktop'}: check left of the title, not in the footer ` + JSON.stringify(r));
      await p.ev(`document.querySelector('#detailDone').click()`); await sleep(150);
      check(await p.ev(`!findTask('${id}') && state.archive.some(a=>a.id==='${id}')`), 'archived');
      await p.ev(`document.querySelector('#toast .toast-act').click()`); await sleep(150);
      check(await p.ev(`!!findTask('${id}')`), 'undo in the message restores the task');
      noErrors(p); await p.close(); current = null;
    }
  });

  await test('coins: own quick values in the settings, kept in the file and merged', async () => {
    const p = await open(browser, base);
    await p.ev(`addTask('q',[0,0]); setCoinsEnabled(true); openSettings&&openSettings()`); await sleep(100);
    await p.ev(`(()=>{const i=document.querySelector('#setCoinQuick');i.value='50, 3, 3, abc, 0, 20000';i.dispatchEvent(new Event('change'));})()`);
    check(await p.ev(`JSON.stringify(state.coins.quick)`) === '[3,50]', 'parsed, sorted, invalid dropped');
    await p.ev(`openDetail(state.tasks.find(t=>t.title==='q').id)`); await sleep(100);
    check(await p.ev(`[...document.querySelectorAll('#dCoinQuick button')].map(b=>b.textContent).join()`) === '0,3,50', 'detail shows the own values');
    await p.ev(`document.querySelector('#dCoinQuick [data-coin-quick="50"]').click()`);
    check(await p.ev(`state.tasks.find(t=>t.title==='q').coins`) === 50, 'quick value sets the coins');
    check(await p.ev(`JSON.stringify(parseFileText(driveText()).coins.quick)`) === '[3,50]', 'kept in the file');
    let bad = false; try { await p.ev(`parseFileText(JSON.stringify({...state,coins:{...state.coins,quick:[0]}}))`); } catch (e) { bad = true; }
    check(bad, 'invalid quick values in a file are rejected');
    const m = await p.ev(`(()=>{const C=o=>JSON.parse(JSON.stringify(o)),b=C(state),l=C(b),r=C(b);l.coins.quick=[2,4];return JSON.stringify(mergeStates(b,l,r).state.coins.quick);})()`);
    check(m === '[2,4]', 'local change of the quick values survives a merge: ' + m);
    await p.ev(`(()=>{const i=document.querySelector('#setCoinQuick');i.value='';i.dispatchEvent(new Event('change'));})()`);
    check(await p.ev(`state.coins.quick===undefined && document.querySelector('#setCoinQuick').value==='1, 5, 10, 25'`), 'empty field restores the default');
    noErrors(p);
  });

  await test('view settings: field names, task font, axis buttons, label filter', async () => {
    const p = await open(browser, base);
    check(await p.ev(`document.querySelectorAll('.ax-origin-btn,.ax-flip-btn').length`) === 0, 'axis buttons hidden by default');
    await p.ev(`setCellNames(false)`);
    check(await p.ev(`[...document.querySelectorAll('.cell-name')].every(e=>e.textContent==='')`), 'field names hidden');
    await p.ev(`setCellNames(true)`);
    check(await p.ev(`[...document.querySelectorAll('.cell-name')].some(e=>e.textContent!=='')`), 'field names back');
    const f100 = await p.ev(`parseFloat(getComputedStyle(document.querySelector('.cell .task-title')).fontSize)`);
    await p.ev(`setTaskFont(140)`);
    const f140 = await p.ev(`parseFloat(getComputedStyle(document.querySelector('.cell .task-title')).fontSize)`);
    check(f140 > f100 * 1.3, `task font grows (${f100} -> ${f140})`);
    await p.ev(`hideAllLabels()`);
    check(await p.ev(`[...document.querySelectorAll('#board .task-card')].filter(e=>e.offsetParent).length`) === 0, 'all hidden');
    await p.ev(`showAllLabels()`);
    check(await p.ev(`[...document.querySelectorAll('#board .task-card')].filter(e=>e.offsetParent).length`) > 0, 'all shown');
    noErrors(p);
  });

  await test('nothing saved yet: the status offers Google Drive first', async () => {
    const p = await open(browser, base, { init: DRIVE_MOCK });
    check((await p.ev(`document.querySelector('#fileStatus').textContent`)).includes('Noch nicht gespeichert'), 'status says nothing is saved yet');
    await p.ev(`document.querySelector('#fileStatus').click()`);
    check(await p.ev(`!document.querySelector('#storePop').hidden`), 'choice opens');
    check(await p.ev(`document.querySelector('#storePop [data-store-action]').dataset.storeAction`) === 'gdrive', 'Google Drive is the first choice');
    await p.ev(`document.querySelector('[data-store-action=gdrive]').click()`); await sleep(500);
    check(await p.ev(`gdriveMode && document.querySelector('#storePop').hidden`), 'connected from the choice');
    noErrors(p);
  });

  await test('help links to the Google Drive connection', async () => {
    const p = await open(browser, base, { init: DRIVE_MOCK });
    await p.ev(`openHelp()`);
    check(await p.ev(`!!document.querySelector('#helpList .help-drive')`), 'link in the help');
    await p.ev(`document.querySelector('#helpList .help-drive').click()`); await sleep(600);
    check(await p.ev(`gdriveMode && !document.querySelector('#helpDlg').open`), 'connected from the help, help closed');
    await p.ev(`openHelp()`);
    check(await p.ev(`!document.querySelector('#helpList .help-drive') && document.querySelector('#helpList').textContent.includes('Mit Google Drive synchronisiert')`), 'plain text once connected');
    noErrors(p);
  });

  await test('new device or cleared site data: connecting loads the own matrix, no example tasks mixed in', async () => {
    const p = await open(browser, base, { init: DRIVE_MOCK });
    await p.ev(`(()=>{const s=JSON.parse(JSON.stringify(state));s.title='Own matrix';s.tasks=[{...s.tasks[0],id:'u1',title:'own 1'},{...s.tasks[1],id:'u2',title:'own 2'}];s.archive=[];
      __drive.files.push({id:'f9',name:'Eisenhower Matrix.matrix.json',version:'5',modifiedTime:new Date().toISOString(),content:JSON.stringify(s)});})()`);
    check(await p.ev(`exampleMode`), 'starts with the example');
    await p.ev(`connectDrive()`); await sleep(800);
    const r = await p.ev(`({title:state.title,tasks:state.tasks.map(t=>t.title),drive:JSON.parse(__drive.files[0].content).tasks.map(t=>t.title),ex:exampleMode})`);
    check(r.title === 'Own matrix' && r.tasks.join() === 'own 1,own 2' && r.drive.join() === 'own 1,own 2' && !r.ex, 'own matrix only: ' + JSON.stringify(r));
    noErrors(p);
  });

  await test('merge: two devices worked offline', async () => {
    const p = await open(browser, base);
    const r = await p.ev(`(()=>{
      const C=o=>JSON.parse(JSON.stringify(o)), base=C(state), L=C(base), R=C(base);
      const [t0,t1,t2,t3]=base.tasks.map(t=>t.id);
      L.tasks.push({...C(base.tasks[4]),id:'L_new',title:'only on laptop',mod:'2026-01-02T10:00:00.000Z'});
      R.tasks.push({...C(base.tasks[4]),id:'R_new',title:'only on phone',mod:'2026-01-02T09:00:00.000Z'});
      Object.assign(L.tasks.find(x=>x.id===t0),{title:'laptop title',mod:'2026-01-02T10:05:00.000Z'});
      Object.assign(R.tasks.find(x=>x.id===t0),{title:'phone title',mod:'2026-01-02T09:30:00.000Z'});
      L.tasks=L.tasks.filter(x=>x.id!==t1);                                   // deleted on laptop, untouched on phone
      L.tasks=L.tasks.filter(x=>x.id!==t2); Object.assign(R.tasks.find(x=>x.id===t2),{title:'kept',mod:'2026-01-02T09:00:00.000Z'}); // deleted vs edited
      const d=R.tasks.find(x=>x.id===t3); R.tasks=R.tasks.filter(x=>x.id!==t3); R.archive.unshift({...d,doneAt:'2026-01-02T09:40:00.000Z',fromCell:d.cell,mod:'2026-01-02T09:40:00.000Z'});
      const {state:m,conflicts}=mergeStates(base,L,R), ids=m.tasks.map(x=>x.id), T=id=>m.tasks.find(x=>x.id===id);
      return {conflicts, L:ids.includes('L_new'), R:ids.includes('R_new'), t0:T(t0)?.title, t1:ids.includes(t1),
        t2:T(t2)?.title, t3arch:m.archive.some(x=>x.id===t3), t3task:ids.includes(t3), n:m.tasks.length, nb:base.tasks.length};
    })()`);
    check(r.L && r.R, 'new tasks of both devices kept');
    check(r.t0 === 'laptop title', 'newer edit wins: ' + r.t0);
    check(r.conflicts === 1, 'one conflict expected, got ' + r.conflicts);
    check(!r.t1, 'deleted on one device, untouched on the other: deleted');
    check(r.t2 === 'kept', 'deleted vs edited: edited one kept');
    check(r.t3arch && !r.t3task, 'done on one device: in the archive');
    check(r.n === r.nb + 2 - 1 - 1, `task count ${r.n}`);
  });

  await test('merge: labels, coins, base missing, identical inputs', async () => {
    const p = await open(browser, base);
    const r = await p.ev(`(()=>{
      const C=o=>JSON.parse(JSON.stringify(o)), base=C(mergeStates(null,state,state).state);   // normalised example
      base.coins={enabled:true,balance:10,rewards:[],log:[]};
      const L=C(base), R=C(base);
      L.labels[0].name='renamed here'; R.labels.push({id:'l_new',name:'new there',color:'#123456'});
      L.coins.log.push({id:'c1',at:'2026-01-02T10:00:00.000Z',amount:5,text:'a',taskId:null}); L.coins.balance=15;
      R.coins.log.push({id:'c2',at:'2026-01-02T11:00:00.000Z',amount:3,text:'b',taskId:null}); R.coins.balance=13;
      const m=mergeStates(base,L,R).state;
      const u=mergeStates(null,L,R).state;
      const same=mergeStates(base,L,L).state;
      return {label0:m.labels[0].name, newLabel:m.labels.some(l=>l.id==='l_new'), balance:m.coins.balance, logs:m.coins.log.length,
        nullTasks:u.tasks.length, nullLabels:u.labels.length, sameTasks:JSON.stringify(same.tasks)===JSON.stringify(L.tasks)};
    })()`);
    check(r.label0 === 'renamed here' && r.newLabel, 'label rename and new label merged');
    check(r.balance === 18 && r.logs === 2, `coins: base 10 + 5 + 3 = ${r.balance}, logs ${r.logs}`);
    check(r.nullTasks > 0 && r.nullLabels === 3, 'merge without base keeps the union');
    check(r.sameTasks, 'merging identical states changes nothing');
  });

  await test('merge: remote swapped axes or resized, local edits survive', async () => {
    const p = await open(browser, base);
    const r = await p.ev(`(()=>{
      const C=o=>JSON.parse(JSON.stringify(o)), base=C(state), L=C(base);
      const nt={...C(base.tasks[0]),id:'L_new',title:'new local',mod:'2026-01-02T10:00:00.000Z'}; L.tasks.push(nt);
      const R1=transposeStateCore(C(base)), m1=mergeStates(base,L,R1).state;
      const expect=transposeStateCore(C(L)).tasks.find(t=>t.id==='L_new').cell;
      const R2=resizeStateCore(C(base),4,4,LANG); L.tasks[0]={...L.tasks[0],title:'edited local',mod:'2026-01-02T10:00:00.000Z'};
      const m2=mergeStates(base,L,R2).state;
      return {swapped:m1.swapped, cell:JSON.stringify(m1.tasks.find(t=>t.id==='L_new').cell), expect:JSON.stringify(expect),
        rows:m2.rows, cols:m2.cols, edited:m2.tasks.some(t=>t.title==='edited local')};
    })()`);
    check(r.swapped === true, 'remote swap taken over');
    check(r.cell === r.expect, `new local task in the transposed cell: ${r.cell} vs ${r.expect}`);
    check(r.rows === 4 && r.cols === 4 && r.edited, 'remote resize taken over, local edit kept');
  });

  await test('Google Drive (emulated): connect, autosave, merge with another device, offline', async () => {
    const p = await open(browser, base, { init: DRIVE_MOCK });
    await p.ev(`connectDrive()`); await sleep(400);
    check(await p.ev(`__drive.files.length`) === 1, 'file created in Drive');
    check(await p.ev(`gdriveMode`) === true, 'Drive mode on');
    await p.ev(`addTask('from this device',[0,0])`); await sleep(1500);
    check(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>t.title==='from this device')`), 'autosave reached Drive');
    // another device writes in between
    await p.ev(`(()=>{const f=__drive.files[0],s=JSON.parse(f.content);s.tasks.push({...s.tasks[0],id:'other',title:'from the other device',mod:new Date().toISOString()});f.content=JSON.stringify(s);f.version=String(++__drive.ver);})()`);
    await p.ev(`addTask('second here',[1,1])`); await sleep(1500);
    const t = await p.ev(`JSON.parse(__drive.files[0].content).tasks.map(t=>t.title)`);
    check(t.includes('from the other device') && t.includes('second here'), 'both devices merged in Drive: ' + t.join(', '));
    check(await p.ev(`state.tasks.some(t=>t.id==='other')`), 'merged state shown here');
    check(await p.ev(`__drive.confirms`) === 0, 'no question asked');
    // Drive raises the version without a content change: nothing is taken over, undo keeps working
    await p.ev(`addTask('undo me',[2,2])`); await sleep(1500);
    await p.ev(`__drive.files[0].version=String(++__drive.ver)`);
    await p.ev(`drivePull()`); await sleep(300);
    check(await p.ev(`undoStack.length>0 && !document.querySelector('#undo').disabled`), 'history kept after a version-only change (pull)');
    await p.ev(`__drive.files[0].version=String(++__drive.ver)`);
    await p.ev(`addTask('undo me too',[2,2])`); await sleep(1500);
    check(await p.ev(`undoStack.length>1`), 'history kept after a version-only change (save)');
    await p.ev(`document.querySelector('#undo').click()`); await p.ev(`document.querySelector('#undo').click()`); await sleep(1500);
    check(!(await p.ev(`state.tasks.some(t=>/^undo me/.test(t.title))`)), 'undo button removes both tasks');
    check(!(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>/^undo me/.test(t.title))`)), 'undo reaches Drive');
    // the other device saves while this one only looks: pulled without writing back
    await p.ev(`(()=>{const f=__drive.files[0],s=JSON.parse(f.content);s.tasks.push({...s.tasks[0],id:'other2',title:'pulled',mod:new Date().toISOString()});f.content=JSON.stringify(s);f.version=String(++__drive.ver);})()`);
    const v0 = await p.ev(`__drive.ver`);
    await p.ev(`drivePull()`); await sleep(300);
    check(await p.ev(`state.tasks.some(t=>t.id==='other2')`), 'change of the other device pulled');
    check(await p.ev(`__drive.ver`) === v0, 'pulling does not write to Drive (no ping-pong)');
    // taking over changes must not interrupt: open detail stays open; while typing nothing is pulled
    const openId = await p.ev(`state.tasks[0].id`);
    await p.ev(`openDetail('${openId}')`); await sleep(200);
    await p.ev(`(()=>{const f=__drive.files[0],s=JSON.parse(f.content);s.tasks.push({...s.tasks[0],id:'other3',title:'quiet',mod:new Date().toISOString()});f.content=JSON.stringify(s);f.version=String(++__drive.ver);})()`);
    await p.ev(`document.querySelector('#search').focus()`);
    await p.ev(`drivePull()`); await sleep(300);
    check(!(await p.ev(`state.tasks.some(t=>t.id==='other3')`)), 'no pull while a field is focused');
    await p.ev(`document.activeElement.blur(); drivePull()`); await sleep(300);
    check(await p.ev(`state.tasks.some(t=>t.id==='other3')`), 'pulled after leaving the field');
    check(await p.ev(`ui.detailId==='${openId}' && !document.querySelector('#detailDrawer').hidden`), 'detail stayed open while taking over changes');
    await p.ev(`closeDetail()`);
    // the other device deletes a task, this one edits something else: the deletion must win
    const gone = await p.ev(`state.tasks[0].id`);
    await p.ev(`(()=>{const f=__drive.files[0],s=JSON.parse(f.content);s.tasks=s.tasks.filter(t=>t.id!=='${gone}');f.content=JSON.stringify(s);f.version=String(++__drive.ver);})()`);
    await p.ev(`addTask('edit after remote delete',[2,0])`); await sleep(1500);
    check(!(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>t.id==='${gone}')`)), 'deleted on the other device stays deleted in Drive');
    check(!(await p.ev(`state.tasks.some(t=>t.id==='${gone}')`)), 'deleted on the other device disappears here');
    // and the other way round: deleted here, pulled by the other device
    const mine = await p.ev(`state.tasks[1].id`);
    await p.ev(`deleteTask?deleteTask('${mine}'):0`); await sleep(1500);
    check(!(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>t.id==='${mine}')`)), 'deleted here is deleted in Drive');
    // offline, then back
    await p.ev(`__drive.offline=true; addTask('offline task',[2,2])`); await sleep(1500);
    check(await p.ev(`gdriveStatusState`) === 'offline', 'status offline');
    await p.ev(`__drive.offline=false; window.dispatchEvent(new Event('online'))`); await sleep(800);
    check(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>t.title==='offline task')`), 'offline change uploaded later');
    // after a restart within the token lifetime: continues by itself
    await p.reload(); await sleep(600);
    check(await p.ev(`gdriveMode&&state.tasks.some(t=>t.title==='offline task')`), 'continued with Drive without a click');
    check(await p.ev(`document.querySelector('#continueBar').hidden && document.querySelector('#syncAlert').hidden`), 'no bar while signed in');
    // lasting connection (token helper configured): an expired token renews itself, no click at all
    if (await p.ev(`!!GDRIVE_TOKEN_URL`)) {
      check(await p.ev(`!!localStorage.getItem('em-gdrive-refresh')`), 'lasting connection stored');
      await p.ev(`localStorage.setItem('em-gdrive-token',JSON.stringify({t:'old',exp:Date.now()-1000}))`);
      await p.reload(); await sleep(800);
      check(await p.ev(`gdriveMode && document.querySelector('#continueBar').hidden`), 'expired token renewed without a click');
      await p.ev(`localStorage.removeItem('em-gdrive-refresh')`);
    } else console.log('      (token helper not configured: lasting-connection check skipped)');
    // token expired: the red bar says so, one click reconnects
    await p.ev(`localStorage.setItem('em-gdrive-token',JSON.stringify({t:'old',exp:Date.now()-1000}))`);
    await p.reload(); await p.ev(`setLang('de')`);
    check(await p.ev(`!document.querySelector('#syncAlert').hidden && !gdriveMode && document.querySelector('#syncAlertText').textContent.includes('getrennt')`), 'red bar after the token expired');
    await p.ev(`document.querySelector('#syncAlertAct').click()`); await sleep(600);
    check(await p.ev(`document.querySelector('#syncAlert').hidden`), 'red bar gone after reconnecting');
    const c = await p.ev(`JSON.stringify({mode:gdriveMode,has:state.tasks.some(t=>t.title==='offline task')})`);
    check(JSON.parse(c).mode && JSON.parse(c).has, 'continued with Drive after one click: ' + c);
    // disconnect forgets the stored sign-in
    await p.ev(`disconnectDrive()`);
    check(await p.ev(`localStorage.getItem('em-gdrive-token')===null && localStorage.getItem('em-gdrive-refresh')===null && !gdriveMode`), 'disconnect clears the stored sign-in');
    noErrors(p);
  });

  await test('missing sync is shown plainly: red bar until it works again', async () => {
    const p = await open(browser, base, { init: DRIVE_MOCK });
    await p.ev(`connectDrive()`); await sleep(400);
    await p.ev(`SYNC_ALERT_MS=1500`);
    const bar = () => p.ev(`(()=>{const b=document.querySelector('#syncAlert');return b.hidden?null:b.dataset.kind+': '+document.querySelector('#syncAlertText').textContent;})()`);
    check(await bar() === null, 'no bar while synced');
    // typing for a long time is no false alarm: the connection is still checked
    await p.ev(`openDetail(state.tasks[0].id); document.querySelector('#dTitle').focus()`);
    for (let i = 0; i < 3; i++) { await p.ev(`drivePull()`); await sleep(700); }
    await p.ev(`renderSyncAlert()`);
    check(await bar() === null, 'no bar while typing and Drive is reachable');
    await p.ev(`document.activeElement.blur(); closeDetail()`);
    // offline: after the limit the bar shows since when, and goes away when Drive is back
    await p.ev(`__drive.offline=true`);
    for (let i = 0; i < 3; i++) { await p.ev(`drivePull()`); await sleep(700); }
    await p.ev(`addTask('while offline',[0,0])`); await sleep(1500); await p.ev(`renderSyncAlert()`);
    const b1 = await bar();
    check(b1 && b1.startsWith('stale') && /Seit \d\d:\d\d/.test(b1), 'stale bar with time: ' + b1);
    await p.ev(`refreshHeader()`);
    check(!(await p.ev(`document.querySelector('#fileStatus').classList.contains('ok')`)), 'status in the header is not green while not synced');
    await p.ev(`__drive.offline=false`); await p.ev(`document.querySelector('#syncAlertAct').click()`); await sleep(800);
    check(await bar() === null, 'bar gone after trying again');
    check(await p.ev(`JSON.parse(__drive.files[0].content).tasks.some(t=>t.title==='while offline')`), 'offline change uploaded');
    // access revoked at Google: bar at once, disconnect makes it local on purpose
    await p.ev(`clearGdriveToken(); localStorage.removeItem('em-gdrive-refresh'); gdriveStatusState='auth'; refreshHeader()`);
    check((await bar() || '').startsWith('lost'), 'lost bar when signed out');
    await p.ev(`document.querySelector('#syncAlertOff').click()`); await sleep(200);
    check(await bar() === null && !(await p.ev(`gdriveMode`)), 'disconnect hides the bar for good');
    await p.reload(); await sleep(400);
    check(await bar() === null, 'no bar after reload once disconnected');
    noErrors(p);
  });

  await browser.send('Browser.close').catch(() => {});
  await Promise.race([new Promise(r => chrome.proc.once('exit', r)), sleep(3000)]);
  chrome.proc.kill(); srv.close();
  // Chrome may still flush its profile for a moment: cleaning up must never fail the run
  if (!process.env.KEEP) { try { fs.rmSync(chrome.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
