/**
 * TURNERO COOTRABAN v2.1 — Servidor Nube (Render.com)
 * =====================================================
 * Cambios v2.1:
 *  - Hora corregida a zona Colombia (UTC-5) en reportes y CSV
 *  - Timestamps en ms enviados al cliente para formato local
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Colombia = UTC-5 permanente (sin horario de verano)
const TZ_OFFSET_MS = -5 * 60 * 60 * 1000;

function nowMs() { return Date.now(); }
function secDiff(a, b) { return Math.round((b - a) / 1000); }
function pad2(n) { return String(n).padStart(2, '0'); }

// Hora en Colombia a partir de un timestamp Unix ms
function fmtTimeCO(ms) {
  if (!ms) return '—';
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function fmtSec(s) {
  if (s == null || s < 0) return '—';
  const m = Math.floor(s / 60), r = s % 60;
  return m > 0 ? `${m}m ${pad2(r)}s` : `${r}s`;
}

// ── Estado operativo ──────────────────────────────────────────────────────────
let state = {
  queues:      { A: [], T: [], S: [] },
  counters:    { A: 0,  T: 0,  S: 0  },
  calledByMod: { 1:null, 2:null, 3:null, 4:null, 5:null, 6:null },
  lastCalled:  null,
  history:     [],
};

let timeLog = [];
const logIdx = {};

// ── HTTP ──────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {

  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (req.url === '/' || req.url === '/turnero.html') {
    const file = path.join(__dirname, 'turnero.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.url === '/reporte' || req.url === '/reporte.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(buildReport(), null, 2));
    return;
  }

  if (req.url === '/reporte.csv') {
    const nowCO = new Date(Date.now() + TZ_OFFSET_MS);
    const fecha = nowCO.toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="turnero-cootraban-${fecha}.csv"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end('\uFEFF' + buildCSV());
    return;
  }

  res.writeHead(404); res.end('No encontrado');
});

// ── Reportes ──────────────────────────────────────────────────────────────────
function buildReport() {
  const atendidos = timeLog.filter(t => t.calledAt && !t.skipped);
  const saltados  = timeLog.filter(t => t.skipped);
  const avgWait   = avg(atendidos.map(t => t.waitSec).filter(n => n != null));
  const avgAttend = avg(atendidos.map(t => t.attendSec).filter(n => n != null));

  const byMod = {};
  atendidos.forEach(t => {
    if (!byMod[t.mod]) byMod[t.mod] = { mod: t.mod, total: 0, _w: [], _a: [] };
    byMod[t.mod].total++;
    if (t.waitSec   != null) byMod[t.mod]._w.push(t.waitSec);
    if (t.attendSec != null) byMod[t.mod]._a.push(t.attendSec);
  });
  Object.values(byMod).forEach(m => {
    m.avgWait = avg(m._w); m.avgAttend = avg(m._a);
    delete m._w; delete m._a;
  });

  const byCat = {};
  ['A','T','S'].forEach(c => {
    const rows = atendidos.filter(t => t.cat === c);
    byCat[c] = { cat: c, total: rows.length,
      avgWait:   avg(rows.map(t => t.waitSec).filter(n => n != null)),
      avgAttend: avg(rows.map(t => t.attendSec).filter(n => n != null)) };
  });

  const nowCO   = new Date(Date.now() + TZ_OFFSET_MS);
  const fechaStr = nowCO.toISOString().slice(0,10).split('-').reverse().join('/');
  const horaStr  = `${pad2(nowCO.getUTCHours())}:${pad2(nowCO.getUTCMinutes())}`;

  return {
    fecha:    fechaStr,
    generado: `${horaStr} (hora Colombia)`,
    resumen: {
      totalEmitidos:       timeLog.length,
      totalAtendidos:      atendidos.length,
      totalSaltados:       saltados.length,
      enEspera:            Object.values(state.queues).flat().length,
      promedioEsperaMin:   avgWait   != null ? +(avgWait  / 60).toFixed(1) : null,
      promedioAtencionMin: avgAttend != null ? +(avgAttend/ 60).toFixed(1) : null,
    },
    porCategoria: byCat,
    porModulo:    Object.values(byMod).sort((a, b) => a.mod - b.mod),
    detalle: timeLog.map(t => ({
      turno:     t.code,
      categoria: catName(t.cat),
      modulo:    t.mod ? `Módulo ${t.mod}` : '—',
      // ms crudos para que el cliente formatee con hora local del navegador
      issuedAt:  t.issuedAt  || null,
      calledAt:  t.calledAt  || null,
      closedAt:  t.closedAt  || null,
      // texto formateado en UTC-5 como respaldo
      emitido:   fmtTimeCO(t.issuedAt),
      llamado:   fmtTimeCO(t.calledAt),
      cerrado:   fmtTimeCO(t.closedAt),
      espera:    fmtSec(t.waitSec),
      atencion:  fmtSec(t.attendSec),
      waitSec:   t.waitSec,
      attendSec: t.attendSec,
      estado:    t.skipped ? 'Saltado' : t.closedAt ? 'Cerrado' : t.calledAt ? 'En atención' : 'En espera',
    })),
  };
}

function buildCSV() {
  const cols = ['Turno','Categoría','Módulo','Emitido','Llamado','Cerrado',
                'Espera (s)','Atención (s)','Estado'];
  const rows = timeLog.map(t => [
    t.code, catName(t.cat), t.mod ? `Módulo ${t.mod}` : '—',
    fmtTimeCO(t.issuedAt), fmtTimeCO(t.calledAt), fmtTimeCO(t.closedAt),
    t.waitSec   != null ? t.waitSec   : '',
    t.attendSec != null ? t.attendSec : '',
    t.skipped ? 'Saltado' : t.closedAt ? 'Cerrado' : t.calledAt ? 'En atención' : 'En espera',
  ]);
  return [cols, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\r\n');
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
function catName(id) {
  return { A:'Asesoría', T:'Tesorería', S:'Solidaridad' }[id] || id;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'STATE', state }));
  ws.send(JSON.stringify({ type: 'REPORT', report: buildReport() }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'TAKE_TICKET': {
        const { cat } = msg;
        if (!['A','T','S'].includes(cat)) break;
        state.counters[cat]++;
        const code = cat + String(state.counters[cat]).padStart(2, '0');
        state.queues[cat].push(code);
        const entry = { code, cat, mod: null,
          issuedAt: nowMs(), calledAt: null, closedAt: null,
          waitSec: null, attendSec: null, skipped: false };
        logIdx[code] = timeLog.length;
        timeLog.push(entry);
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        ws.send(JSON.stringify({ type: 'TICKET_OK', code, cat }));
        break;
      }

      case 'CALL_NEXT': {
        const { mod, cats } = msg;
        const prevCode = state.calledByMod[mod];
        if (prevCode && logIdx[prevCode] !== undefined) {
          const prev = timeLog[logIdx[prevCode]];
          if (prev && prev.calledAt && !prev.closedAt) {
            prev.closedAt  = nowMs();
            prev.attendSec = secDiff(prev.calledAt, prev.closedAt);
          }
        }
        let found = null;
        for (const c of cats) {
          if (state.queues[c] && state.queues[c].length > 0) {
            const code = state.queues[c].shift();
            found = { code, cat: c }; break;
          }
        }
        if (!found) { ws.send(JSON.stringify({ type: 'NO_TURNS' })); break; }
        state.calledByMod[mod] = found.code;
        state.lastCalled = { ...found, mod };
        state.history.unshift({ code: found.code, del: false });
        if (state.history.length > 30) state.history.pop();
        const idx = logIdx[found.code];
        if (idx !== undefined) {
          timeLog[idx].mod      = mod;
          timeLog[idx].calledAt = nowMs();
          timeLog[idx].waitSec  = secDiff(timeLog[idx].issuedAt, timeLog[idx].calledAt);
        }
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        break;
      }

      case 'RECALL':
        broadcast({ type: 'STATE', state });
        break;

      case 'CLOSE_TURN': {
        const { code, mod } = msg;
        const idx = logIdx[code];
        if (idx !== undefined && timeLog[idx].calledAt && !timeLog[idx].closedAt) {
          timeLog[idx].closedAt  = nowMs();
          timeLog[idx].attendSec = secDiff(timeLog[idx].calledAt, timeLog[idx].closedAt);
        }
        state.calledByMod[mod] = null;
        const hi = state.history.find(h => h.code === code);
        if (hi) hi.closed = true;
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        break;
      }

      case 'SKIP_CURRENT': {
        const { code, mod } = msg;
        const hi = state.history.findIndex(h => h.code === code && !h.del);
        if (hi >= 0) state.history[hi].del = true;
        state.calledByMod[mod] = null;
        const idx = logIdx[code];
        if (idx !== undefined) {
          timeLog[idx].skipped  = true;
          timeLog[idx].closedAt = nowMs();
          if (timeLog[idx].calledAt)
            timeLog[idx].attendSec = secDiff(timeLog[idx].calledAt, timeLog[idx].closedAt);
        }
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        break;
      }

      case 'REMOVE_QUEUE': {
        const { code, cat } = msg;
        const i = state.queues[cat].indexOf(code);
        if (i >= 0) state.queues[cat].splice(i, 1);
        const idx = logIdx[code];
        if (idx !== undefined) { timeLog[idx].skipped = true; timeLog[idx].closedAt = nowMs(); }
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        break;
      }

      case 'RESET_ALL':
        console.log(`[RESET] ${new Date().toISOString()} — ${timeLog.length} turnos`);
        timeLog = [];
        Object.keys(logIdx).forEach(k => delete logIdx[k]);
        state = {
          queues:      { A:[], T:[], S:[] },
          counters:    { A:0, T:0, S:0 },
          calledByMod: { 1:null,2:null,3:null,4:null,5:null,6:null },
          lastCalled:  null, history: [],
        };
        broadcast({ type: 'STATE', state });
        broadcast({ type: 'REPORT', report: buildReport() });
        break;

      case 'GET_REPORT':
        ws.send(JSON.stringify({ type: 'REPORT', report: buildReport() }));
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
const APP_URL = process.env.APP_URL;
if (APP_URL) {
  setInterval(() => {
    const url = new URL('/ping', APP_URL);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    mod.get(url.toString(), r => console.log(`[keep-alive] ${r.statusCode}`))
       .on('error', e => console.warn('[keep-alive]', e.message));
  }, 10 * 60 * 1000);
  console.log(`[keep-alive] activo → ${APP_URL}`);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\nTurnero Cootraban v2.1 — puerto ${PORT}`);
  if (APP_URL) console.log(`URL: ${APP_URL}`);
});
