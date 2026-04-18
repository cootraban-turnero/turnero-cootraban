/**
 * TURNERO COOTRABAN — Servidor Nube (Render.com)
 * ================================================
 * Desplegado en: https://[tu-app].onrender.com
 * Acceso desde cualquier dispositivo con internet.
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Estado compartido ────────────────────────────────────────────────────────
let state = {
  queues:      { A: [], T: [], S: [] },
  counters:    { A: 0,  T: 0,  S: 0  },
  calledByMod: { 1:null,2:null,3:null,4:null,5:null,6:null },
  lastCalled:  null,
  history:     [],
};

// ── Servidor HTTP ────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Endpoint de salud — Render lo usa para saber que el servidor vive
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (req.url === '/' || req.url === '/turnero.html') {
    const file = path.join(__dirname, 'turnero.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404); res.end('turnero.html no encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(404); res.end('No encontrado');
});

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'STATE', state }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'TAKE_TICKET': {
        const { cat } = msg;
        if (!['A','T','S'].includes(cat)) break;
        state.counters[cat]++;
        const code = cat + String(state.counters[cat]).padStart(2,'0');
        state.queues[cat].push(code);
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'TICKET_OK', code, cat }));
        break;
      }

      case 'CALL_NEXT': {
        const { mod, cats } = msg;
        let found = null;
        for (const c of cats) {
          if (state.queues[c] && state.queues[c].length > 0) {
            const code = state.queues[c].shift();
            found = { code, cat: c };
            break;
          }
        }
        if (!found) { ws.send(JSON.stringify({ type: 'NO_TURNS' })); break; }
        state.calledByMod[mod] = found.code;
        state.lastCalled = { ...found, mod };
        state.history.unshift({ code: found.code, del: false });
        if (state.history.length > 30) state.history.pop();
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'STATE', state }));
        break;
      }

      case 'RECALL': {
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'STATE', state }));
        break;
      }

      case 'SKIP_CURRENT': {
        const { code, mod } = msg;
        const idx = state.history.findIndex(h => h.code === code && !h.del);
        if (idx >= 0) state.history[idx].del = true;
        state.calledByMod[mod] = null;
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'STATE', state }));
        break;
      }

      case 'REMOVE_QUEUE': {
        const { code, cat } = msg;
        const i = state.queues[cat].indexOf(code);
        if (i >= 0) state.queues[cat].splice(i, 1);
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'STATE', state }));
        break;
      }

      case 'RESET_ALL': {
        state = {
          queues:      { A:[], T:[], S:[] },
          counters:    { A:0, T:0, S:0 },
          calledByMod: { 1:null,2:null,3:null,4:null,5:null,6:null },
          lastCalled:  null,
          history:     [],
        };
        broadcast({ type: 'STATE', state });
        ws.send(JSON.stringify({ type: 'STATE', state }));
        break;
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// ── Keep-alive: evita que Render duerma el servidor ─────────────────────────
// En el plan gratuito, Render apaga el servidor tras 15 min sin peticiones.
// Este ping interno cada 10 min lo mantiene despierto durante la jornada.
// Ajusta APP_URL en las variables de entorno de Render (ver guía).
const APP_URL = process.env.APP_URL;
if (APP_URL) {
  setInterval(() => {
    const url = new URL('/ping', APP_URL);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    mod.get(url.toString(), r => {
      console.log(`[keep-alive] ping → ${r.statusCode}`);
    }).on('error', e => {
      console.warn('[keep-alive] error:', e.message);
    });
  }, 10 * 60 * 1000); // cada 10 minutos
  console.log(`[keep-alive] activo → ${APP_URL}`);
}

// ── Arranque ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\nTurnero Cootraban corriendo en puerto ${PORT}`);
  if (APP_URL) console.log(`URL pública: ${APP_URL}`);
});
