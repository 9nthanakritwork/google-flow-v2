// Hermes Warehouse Server — เสิร์ฟ warehouse.html ผ่าน LAN + เก็บ state กลางแบบเรียลไทม์ (no deps, pure node)
import http from 'http';
import fs from 'fs';
import path from 'path';

const DEV = process.env.FLOW_DEV_DIR || path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'); // default = โฟลเดอร์ server/ ของ kit (portable)
const PORT = parseInt(process.env.WAREHOUSE_PORT || process.env.PORT || '8899', 10);
const STATE_FILE = path.join(DEV, 'warehouse_state.json');
const QUEUE_FILE = path.join(DEV, 'product_list.json');
const CUSTOM_FILE = path.join(DEV, 'presets', 'custom_presets.json');
const MAX_BODY = 500 * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm' };

// แตกสินค้า 1 ชิ้น x N รอบ → คิวงานรายรอบ (บทพูดวนตามลำดับ, รอบเกินวนซ้ำ)
async function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? (import('https').then(m=>m.default)) : (import('http').then(m=>m.default));
    mod.then(h => {
      const req = h.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchImageAsBase64(res.headers.location).then(resolve);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const ct = res.headers['content-type'] || 'image/jpeg';
          const b64 = Buffer.concat(chunks).toString('base64');
          resolve('data:' + ct + ';base64,' + b64);
        });
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    }).catch(() => resolve(''));
  });
}

function expandQueue(products) {
  const items = [];
  for (const p of products || []) {
    if (p.status !== 'queued') continue;
    const speeches = (p.speeches && p.speeches.length ? p.speeches : [p.speech || '']).map(s => (s || '').trim()).filter(Boolean);
    const n = Math.max(1, p.rounds || 0, speeches.length || 0);
    for (let i = 0; i < n; i++) {
      items.push({
        id: `${p.id}_r${i + 1}`, product_id: p.id, round: i + 1, rounds: n,
        product_name: p.name, product_image: p.image_file || '', image_data: p.image_data || '',
        image_preset: p.image_preset, video_preset: p.video_preset,
        speech_th: speeches.length ? speeches[i % speeches.length] : '',
        platform: p.platform || '', account: p.account || '',
        ratio: p.ratio || '9:16', duration: p.duration || '10s',
        status: 'queued', output_video: ''
      });
    }
  }
  return items;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.from(body, 'utf-8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(buf);
}

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  // serve flow_output files (videos/images) from ShopeeAffiliate reports via /output/
  if (clean.startsWith('/output/')) {
    const rel = clean.replace('/output/', '');
    const base = (process.env.FLOW_OUT_DIR || '/home/hermes/DEV/media/output/');
    const full = path.join(base, rel);
    if (!path.resolve(full).startsWith(path.resolve(base))) return null;
    return full;
  }
  const full = path.normalize(path.join(DEV, clean === '/' ? 'warehouse.html' : clean));
  if (!full.startsWith(DEV)) return null;
  return full;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { products: [], customPresets: { image: {}, video: {} }, updated_at: 0 }; }
}

function loadPresets() {
  const img = JSON.parse(fs.readFileSync(path.join(DEV, 'presets', '_img_slim.json'), 'utf-8'));
  const vid = JSON.parse(fs.readFileSync(path.join(DEV, 'presets', '_vid_slim.json'), 'utf-8'));
  let custom = { image: {}, video: {} };
  try { custom = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf-8')); } catch {}
  return {
    image: { ...img, ...(custom.image || {}) },
    video: { ...vid, ...(custom.video || {}) }
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/warehouse.html')) {
      const html = fs.readFileSync(path.join(DEV, 'warehouse.html'), 'utf-8');
      return send(res, 200, html, MIME['.html']);
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      return send(res, 200, JSON.stringify(loadState()));
    }
    if (req.method === 'GET' && req.url === '/api/hostinfo') {
      // บอก client ว่าเปิดหน้านี้จาก IP ไหนได้ (ย้ายเครื่อง/IP ใหม่ แสดงถูกอัตโนมัติ)
      const os = await import('os');
      const nets = os.networkInterfaces();
      let lan = '127.0.0.1';
      for (const name of Object.keys(nets)) {
        for (const n of nets[name] || []) {
          if (n.family === 'IPv4' && !n.internal && (n.address.startsWith('192.168.') || n.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(n.address))) {
            lan = n.address; break;
          }
        }
        if (lan !== '127.0.0.1') break;
      }
      return send(res, 200, JSON.stringify({ lanUrl: `http://${lan}:8899`, port: PORT }));
    }
    if (req.method === 'POST' && req.url === '/api/state') {
      const body = JSON.parse(await readBody(req));
      const incoming = body.customPresets || {};
      // tombstones: ids deleted by user (incl. built-ins)
      const deletedIds = Array.isArray(body.__deleted) ? body.__deleted
        : (Array.isArray(incoming.__deleted) ? incoming.__deleted : []);
      // FIX: merge incoming ON TOP OF existing custom_presets.json
      // so presets added via file/CLI are never wiped by a browser save
      // that doesn't know about them. Tombstones still win (deleted = gone).
      let existingCustom = { image: {}, video: {} };
      try { existingCustom = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch {}
      const mergedPresets = {
        image: Object.assign({}, existingCustom.image || {}, incoming.image || {}),
        video: Object.assign({}, existingCustom.video || {}, incoming.video || {}),
        __deleted: deletedIds
      };
      // Apply tombstones — remove anything user explicitly deleted
      for (const id of deletedIds) {
        delete mergedPresets.image[id];
        delete mergedPresets.video[id];
      }
      const state = { products: body.products || [], customPresets: mergedPresets, deletedPresets: deletedIds, updated_at: Date.now() };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
      fs.writeFileSync(CUSTOM_FILE, JSON.stringify(state.customPresets, null, 2));
      const items = expandQueue(state.products);
      // Auto-fetch image_data for items that have all_images but no image_data
      for (const it of items) {
        if (!it.image_data) {
          const prod = (state.products || []).find(p => p.id === it.product_id);
          if (prod && prod.all_images && prod.all_images.length > 0) {
            const imgUrl = prod.all_images[prod.selected_image_idx || 0];
            if (imgUrl) {
              try { it.image_data = await fetchImageAsBase64(imgUrl); } catch {}
            }
          }
        }
      }
      // กันเซฟทับความคืบหน้ากลางรัน: คงสถานะเดิม (running/done/failed+note+วิดีโอ) ของรอบ id เดิมไว้
      try {
        const old = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
        const byId = new Map((old.items || []).map(i => [i.id, i]));
        for (const it of items) {
          const prev = byId.get(it.id);
          if (prev && prev.status && prev.status !== 'queued') {
            it.status = prev.status;
            if (prev.output_video) it.output_video = prev.output_video;
            if (prev.progress_note) it.progress_note = prev.progress_note;
            if (prev.updated_at) it.updated_at = prev.updated_at;
          }
        }
      } catch {}
      fs.writeFileSync(QUEUE_FILE, JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, items }, null, 2));
      return send(res, 200, JSON.stringify({ ok: true, updated_at: state.updated_at, queue_count: items.length }));
    }
    if (req.method === 'GET' && req.url === '/api/queue') {
      try { return send(res, 200, fs.readFileSync(QUEUE_FILE, 'utf-8')); }
      catch { return send(res, 200, JSON.stringify({ exported_at: new Date().toISOString(), count: 0, items: [] })); }
    }
    if (req.method === 'GET' && req.url === '/api/queue/status') {
      // LIGHT endpoint for polling: id+status only (full /api/queue is ~18MB with image_data — never poll it)
      try {
        const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
        const items = (q.items || []).map(i => ({ id: i.id, status: i.status, has_video: !!i.output_video }));
        return send(res, 200, JSON.stringify({ count: q.count || items.length, items }));
      } catch { return send(res, 200, JSON.stringify({ count: 0, items: [] })); }
    }
    if (req.method === 'GET' && req.url === '/api/state/meta') {
      // LIGHT endpoint for polling: only version stamp (full /api/state is ~12MB — pull full only when changed)
      try {
        const s = loadState();
        return send(res, 200, JSON.stringify({ updated_at: s.updated_at || 0, product_count: (s.products || []).length }));
      } catch { return send(res, 200, JSON.stringify({ updated_at: 0, product_count: 0 })); }
    }
    // Live progress: batch runner รายงาน running/done ทีละรอบ → หน้า warehouse เห็นว่ากำลังทำอะไร
    // POST {"id":"p1_r1","status":"running|done|failed","note":"API video submit i2v"}
    if (req.method === 'POST' && req.url === '/api/progress') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !body.status) return send(res, 400, JSON.stringify({ error: 'need id + status' }));
      let q;
      try { q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); }
      catch { return send(res, 404, JSON.stringify({ error: 'no queue file' })); }
      const it = (q.items || []).find(i => i.id === body.id);
      if (!it) return send(res, 404, JSON.stringify({ error: 'id not in queue' }));
      it.status = body.status;
      if (body.note) it.progress_note = String(body.note).slice(0, 200);
      if (body.output_video) it.output_video = body.output_video;
      it.updated_at = new Date().toISOString();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));

      // Real-time activity log append
      try {
        let act = { events: [] };
        try { act = JSON.parse(fs.readFileSync(path.join(DEV, 'activity_log.json'), 'utf-8')); } catch {}
        act.events.unshift({
          ts: new Date().toISOString(),
          id: it.id,
          status: body.status || '',
          note: (body.note || body.status || '') + (it.product_name ? ` (${it.product_name.slice(0, 28)})` : ''),
          output: body.output_video || ''
        });
        act.events = act.events.slice(0, 50);
        fs.writeFileSync(path.join(DEV, 'activity_log.json'), JSON.stringify(act));
      } catch {}

      return send(res, 200, JSON.stringify({ ok: true, id: it.id, status: it.status }));
    }
    if (req.method === 'GET' && req.url === '/api/credits') {
      try {
        const pool = JSON.parse(fs.readFileSync(path.join(DEV, 'api-custom-flow', 'account_pool.json'), 'utf8'));
        const active = pool.accounts.find(a => a.id === pool.active_account_id) || pool.accounts[0];
        const rem = active.daily_credit_limit - active.credits_used_today;
        return send(res, 200, JSON.stringify({ ok: true, active_id: active.id, email: active.email, credits: rem, total: active.daily_credit_limit }));
      } catch (e) {
        return send(res, 200, JSON.stringify({ ok: false, credits: '—' }));
      }
    }
    if (req.method === 'GET' && req.url === '/api/presets') {
      const presetData = loadPresets();
      const state = loadState();
      // merge custom presets, then apply tombstones (deleted ids never come back)
      const delIds = state.deletedPresets || state.customPresets?.__deleted || [];
      const strip = (obj) => { const o = { ...(obj || {}) }; for (const k of delIds) delete o[k]; return o; };
      return send(res, 200, JSON.stringify({
        image: strip({ ...presetData.image, ...(state.customPresets?.image || {}) }),
        video: strip({ ...presetData.video, ...(state.customPresets?.video || {}) })
      }));
    }
    // === api-custom-flow automation bridge ===
    // --- helper: kick Chrome start in background (fire-and-forget) ---
    async function kickChrome() {
      const { execSync } = await import('child_process');
      try { execSync('curl -sf --connect-timeout 2 http://localhost:9333/json/version -o /dev/null'); return false; } catch {}
      // If Chrome port 9333 is not running, runner handles it or uses account_rotator
      return false;
    }

    if (req.method === 'POST' && req.url === '/api/flow/run') {
      const body = JSON.parse(await readBody(req).catch(()=>'{}'));
      const mode = body.mode || 'once'; // once | dry
      const { spawn, execSync } = await import('child_process');
      try { const out = execSync("pgrep -f '[w]arehouse_flow_v2\\.mjs'").toString().trim(); if (out) return send(res, 409, JSON.stringify({ ok: false, error: 'runner_already_running' })); } catch {}
      // kick Chrome start (fire-and-forget) — runner รอ CDP เองใน retry loop
      const chromeStarted = kickChrome();
      // v2: Pure Wire runner (Omni Flash & Batchexecute RPC). Old runner kept as legacy reference.
      const runner = process.env.FLOW_RUNNER_PATH || '/home/hermes/DEV/api-custom-flow/warehouse_flow_v2.mjs';
      const logFd = fs.openSync('/home/hermes/DEV/api-custom-flow/runner.log', 'a');
      const args = mode==='dry' ? ['--dry'] : [];
      if (body.ids && Array.isArray(body.ids) && body.ids.length > 0) {
        args.push(`--ids=${body.ids.join(',')}`);
      }
      const child = spawn(process.execPath, [runner, ...args], { cwd: path.dirname(runner), detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, FLOW_DEV_DIR: DEV, FLOW_SDK_DIR: process.env.FLOW_SDK_DIR || DEV + '/api-custom-flow', FLOW_OUT_DIR: process.env.FLOW_OUT_DIR || '/home/hermes/ShopeeVideo', FLOW_PROJECT_ID: process.env.FLOW_PROJECT_ID || '760af8b7-4f35-4453-aec3-8e6ad5a2800a', CDP_PORT: process.env.CDP_PORT || '9333', FLOW_WAREHOUSE_URL: process.env.FLOW_WAREHOUSE_URL || 'http://127.0.0.1:8899' } });
      child.unref();
      return send(res, 200, JSON.stringify({ ok: true, mode, runner: 'api_v2', pid: child.pid, chrome_starting: chromeStarted }));
    }
    if (req.method === 'GET' && req.url === '/api/flow/status') {
      try{
        const q = JSON.parse(fs.readFileSync(QUEUE_FILE,'utf-8'));
        const queued = q.items.filter(i=>i.status==='queued').length;
        const running = q.items.filter(i=>i.status==='running').length;
        const done = q.items.filter(i=>i.status==='done').length;
        const failed = q.items.filter(i=>i.status==='failed').length;
        return send(res, 200, JSON.stringify({ ok:true, queued, running, done, failed, total:q.count }));
      }catch{ return send(res, 200, JSON.stringify({ ok:true, queued:0, running:0, done:0, failed:0, total:0 })); }
    }
    // === api-custom-flow drain: run warehouse_flow_v2.mjs until queue empty ===
    if (req.method === 'POST' && req.url === '/api/flow/drain') {
      const { spawn, execSync } = await import('child_process');
      try { const out = execSync("pgrep -f '[w]arehouse_flow_v2\\.mjs'").toString().trim(); if (out) return send(res, 409, JSON.stringify({ ok: false, error: 'runner_already_running' })); } catch {}
      // kick Chrome start (fire-and-forget)
      const chromeStarted = kickChrome();
      const runner = process.env.FLOW_RUNNER_PATH || '/home/hermes/DEV/api-custom-flow/warehouse_flow_v2.mjs';
      // Launch runner in background — it loops internally until queue empty
      const child = spawn(process.execPath, [runner], { cwd: path.dirname(runner), detached: true, stdio: 'ignore', env: { ...process.env, FLOW_DEV_DIR: DEV, FLOW_SDK_DIR: process.env.FLOW_SDK_DIR || DEV + '/api-custom-flow', FLOW_OUT_DIR: process.env.FLOW_OUT_DIR || '/home/hermes/ShopeeVideo', FLOW_PROJECT_ID: process.env.FLOW_PROJECT_ID || '760af8b7-4f35-4453-aec3-8e6ad5a2800a', CDP_PORT: process.env.CDP_PORT || '9333', FLOW_WAREHOUSE_URL: process.env.FLOW_WAREHOUSE_URL || 'http://127.0.0.1:8899' } });
      child.unref();
      return send(res, 200, JSON.stringify({ ok: true, message: "Drain started in background — runner loops until queued=0" }));
    }
    // === stop: kill running runner + flip stale 'running' items back to 'queued' ===
    if (req.method === 'POST' && req.url === '/api/flow/stop') {
      const { execSync } = await import('child_process');
      let killed = 0;
      try {
        const pids = execSync("pgrep -f '[w]arehouse_flow_v2\\.mjs'").toString().trim().split('\n').map(s => s.trim()).filter(Boolean);
        for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); killed++; } catch {} }
      } catch {}
      let reset = 0;
      try {
        const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
        for (const it of q.items || []) {
          if (it.status === 'running') { it.status = 'queued'; delete it.progress_note; delete it.updated_at; reset++; }
        }
        q.count = (q.items || []).length;
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
      } catch {}
      return send(res, 200, JSON.stringify({ ok: true, killed, reset }));
    }
    if (req.method === 'POST' && req.url === '/api/flow/requeue') {
      const body = JSON.parse(await readBody(req).catch(()=> '{}'));
      const target = body.id; // optional single id
      let q;
      try{ q = JSON.parse(fs.readFileSync(QUEUE_FILE,'utf-8')); }catch{ return send(res, 404, JSON.stringify({ error:'no queue' })); }
      let n=0;
      for(const it of q.items){
        if(target && it.id!==target) continue;
        if(!target && it.status==='done') continue; // requeue only failed/running by default
        if(target || it.status==='failed' || it.status==='running'){
          it.status='queued'; delete it.progress_note; delete it.output_video; delete it.updated_at; n++;
        }
      }
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(q,null,2));
      return send(res, 200, JSON.stringify({ ok:true, requeued:n }));
    }
    // Delete a queue item (fixes orphan items that can't be deleted from dashboard)
    if (req.method === 'POST' && req.url === '/api/queue/delete') {
      const body = JSON.parse(await readBody(req).catch(()=> '{}'));
      if (!body.id) return send(res, 400, JSON.stringify({ error: 'need id' }));
      let q;
      try{ q = JSON.parse(fs.readFileSync(QUEUE_FILE,'utf-8')); }catch{ return send(res, 404, JSON.stringify({ error:'no queue' })); }
      const before = q.items.length;
      q.items = q.items.filter(i => i.id !== body.id);
      q.count = q.items.length;
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(q,null,2));
      return send(res, 200, JSON.stringify({ ok:true, deleted: before - q.items.length }));
    }
    // Purge orphan/undefined items from queue
    if (req.method === 'POST' && req.url === '/api/queue/purge-orphans') {
      let q;
      try{ q = JSON.parse(fs.readFileSync(QUEUE_FILE,'utf-8')); }catch{ return send(res, 404, JSON.stringify({ error:'no queue' })); }
      const before = q.items.length;
      q.items = q.items.filter(i => i.product_id && i.product_id !== 'undefined' && !i.id.startsWith('undefined'));
      q.count = q.items.length;
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(q,null,2));
      return send(res, 200, JSON.stringify({ ok:true, purged: before - q.items.length }));
    }
    // Live activity log for dashboard monitor (runner posts via /api/activity)
    if (req.method === 'GET' && req.url === '/api/activity') {
      try { return send(res, 200, fs.readFileSync(path.join(DEV,'activity_log.json'),'utf-8')); }
      catch { return send(res, 200, JSON.stringify({ events: [] })); }
    }
    if (req.method === 'POST' && req.url === '/api/activity') {
      const body = JSON.parse(await readBody(req).catch(()=> '{}'));
      let log = { events: [] };
      try { log = JSON.parse(fs.readFileSync(path.join(DEV,'activity_log.json'),'utf-8')); } catch {}
      log.events.unshift({ ts: new Date().toISOString(), id: body.id || '', status: body.status || '', note: body.note || '', output: body.output || '' });
      log.events = log.events.slice(0, 50);
      fs.writeFileSync(path.join(DEV,'activity_log.json'), JSON.stringify(log));
      return send(res, 200, JSON.stringify({ ok:true }));
    }
    if (req.method === 'GET') {
      const f = safePath(req.url);
      if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const ext = path.extname(f).toLowerCase();
        if (MIME[ext]) return send(res, 200, fs.readFileSync(f, 'utf-8'), MIME[ext]);
      }
      return send(res, 404, JSON.stringify({ error: 'not found' }));
    }
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Warehouse server on http://0.0.0.0:${PORT}/warehouse.html`);
});
