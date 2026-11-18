/* Motor de sincronización por registro (sin dependencias).
   Cada producto, contacto, venta/gasto y cotización es un documento propio con
   una marca de tiempo `_u`. Gana la versión más reciente de CADA registro, así que
   dos aparatos pueden trabajar a la vez sin pisarse el negocio completo.
   Los borrados viajan como "lápidas" ({_del:true,_u}). */

export const COLS = ['prods', 'cts', 'tx', 'est', 'biz'];

const strip = r => { const o = {}; for (const k of Object.keys(r)) if (k !== '_u') o[k] = r[k]; return o; };
const clean = r => JSON.parse(JSON.stringify(r));
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
const sig = r => stable(strip(r));
const byId = (a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/* backend: { set(col,id,data) -> Promise, listen(col, cb) -> unsubscribe }
   cb(changes, meta): changes=[{id,type,data}], meta={fromCache,offline,pending} */
export function createSync({ getState, backend, onChange, onStatus, onError, now = () => Date.now(), deadline = 6000 }) {
  const S = () => getState();
  const known = {}, tombU = {}, ready = {};
  COLS.forEach(c => { known[c] = {}; tombU[c] = {}; ready[c] = false; });
  let all = false, stops = [], timer = null, stopped = false, pendingWrites = false;

  const list = c => c === 'biz' ? [Object.assign({ id: 'main' }, S().biz)] : (S()[c] || []);
  const setU = (c, r, u) => { if (c === 'biz') S().biz._u = u; else r._u = u; };
  const liveData = (c, r) => c === 'biz' ? clean(Object.assign({ id: 'main' }, S().biz)) : clean(r);

  function upsert(c, d) {
    const rec = clean(d);
    if (c === 'biz') { delete rec.id; Object.assign(S().biz, rec); return; }
    const arr = S()[c] || (S()[c] = []);
    const i = arr.findIndex(x => x.id === rec.id);
    if (i >= 0) arr[i] = rec; else arr.push(rec);
  }
  function remove(c, id) {
    if (c === 'biz') return;
    S()[c] = (S()[c] || []).filter(x => x.id !== id);
  }

  function apply(c, id, d) {
    const loc = list(c).find(r => r.id === id);
    if (d._del) {
      tombU[c][id] = d._u || 0;
      if (loc && (loc._u || 0) <= (d._u || 0)) { remove(c, id); known[c][id] = 'DEL'; return true; }
      if (!loc) known[c][id] = 'DEL';
      return false;
    }
    if (known[c][id] === 'DEL' && !loc && (d._u || 0) <= (tombU[c][id] || 0)) return false;
    const u = d._u || 0;
    if (!loc) { upsert(c, d); known[c][id] = sig(d); return true; }
    if ((loc._u || 0) < u) { upsert(c, d); known[c][id] = sig(d); return true; }
    if (sig(loc) === sig(d)) known[c][id] = sig(d);
    return false; // el local es más nuevo: pushDiff lo subirá
  }

  function send(c, id, data) {
    try { Promise.resolve(backend.set(c, id, data)).catch(e => onError && onError(e)); }
    catch (e) { onError && onError(e); }
  }

  function pushDiff() {
    for (const c of COLS) {
      const cur = list(c), ids = new Set();
      for (const r of cur) {
        ids.add(r.id);
        const s = sig(r);
        if (known[c][r.id] === s) continue;
        const had = known[c][r.id] !== undefined && known[c][r.id] !== 'DEL';
        if (!r._u || had) setU(c, c === 'biz' ? null : r, now());
        known[c][r.id] = s;
        send(c, r.id, liveData(c, c === 'biz' ? null : r));
      }
      if (c === 'biz') continue;
      for (const id of Object.keys(known[c])) {
        if (known[c][id] !== 'DEL' && !ids.has(id)) {
          const u = now();
          known[c][id] = 'DEL'; tombU[c][id] = u;
          send(c, id, { id, _del: true, _u: u });
        }
      }
    }
  }

  function checkAll() {
    if (all || !COLS.every(c => ready[c])) return;
    all = true; clearTimeout(timer);
    pushDiff();
    onStatus && onStatus({ ready: true, pending: pendingWrites });
  }

  function start() {
    stopped = false;
    timer = setTimeout(() => { COLS.forEach(c => { ready[c] = true; }); checkAll(); }, deadline);
    for (const c of COLS) {
      const un = backend.listen(c, (changes, meta = {}) => {
        if (stopped) return;
        pendingWrites = !!meta.pending;
        if (!ready[c] && (!meta.fromCache || meta.offline)) ready[c] = true;
        let changed = false;
        for (const x of changes) {
          if (x.type === 'removed' || !x.data) continue;
          if (apply(c, x.id, x.data)) changed = true;
        }
        if (changed) {
          if (c === 'tx' || c === 'est') S()[c].sort(byId);
          onChange && onChange(c);
        }
        if (all) pushDiff(); else checkAll();
        onStatus && onStatus({ ready: all, pending: pendingWrites, fromCache: !!meta.fromCache });
      }, e => onError && onError(e));
      stops.push(un);
    }
  }

  return {
    start,
    stop() { stopped = true; clearTimeout(timer); stops.forEach(f => { try { f && f(); } catch (e) {} }); stops = []; },
    local() { if (all && !stopped) pushDiff(); },
    isReady: () => all
  };
}
