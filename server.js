// ─────────────────────────────────────────────────────────────────────────────
// server.js  —  Backend per Google Calendar
// Studio Legale Avv. Girolamo Ceci
//
// Legge le variabili d'ambiente (impostate su Render.com):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   CALENDAR_ID   (default: girolamo.ceci@gmail.com)
//   PORT          (default: 3000)
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const http  = require("http");
const url   = require("url");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const CALENDAR_ID   = process.env.CALENDAR_ID          || "girolamo.ceci@gmail.com";
const PORT          = parseInt(process.env.PORT || "3000");

// ── Ottieni access token da refresh token ────────────────────────────────────
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    "refresh_token",
    });
    const req = https.request(
      { hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.access_token) resolve(j.access_token);
            else reject(new Error(j.error_description || "Token error"));
          } catch(e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Chiamata generica alle Google Calendar API ────────────────────────────────
function gcalRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(
      { hostname: "www.googleapis.com", path, method, headers },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch(e) { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── CORS headers ─────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── JSON response helper ──────────────────────────────────────────────────────
function json(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ── Leggi body della request ──────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch(e) { resolve({}); }
    });
  });
}

// ── SERVER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);

  // Preflight CORS
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // ── GET /health  (test connessione) ────────────────────────────────────────
  if (req.method === "GET" && path === "/health") {
    return json(res, 200, { ok: true, calendar: CALENDAR_ID });
  }

  // ── GET /eventi?da=YYYY-MM-DD&a=YYYY-MM-DD ─────────────────────────────────
  if (req.method === "GET" && path === "/eventi") {
    try {
      const token = await getAccessToken();
      const da    = parsed.query.da || new Date().toISOString().slice(0,10);
      const fine  = new Date(da);
      fine.setDate(fine.getDate() + 35);
      const a = parsed.query.a || fine.toISOString().slice(0,10);

      const calId = encodeURIComponent(CALENDAR_ID);
      const gcPath = `/calendar/v3/calendars/${calId}/events`
        + `?timeMin=${da}T00:00:00+02:00`
        + `&timeMax=${a}T23:59:59+02:00`
        + `&singleEvents=true&orderBy=startTime&maxResults=200`;

      const r = await gcalRequest("GET", gcPath, token, null);
      if (r.status !== 200) return json(res, 502, { error: "Errore Google Calendar", detail: r.body });

      // Raggruppa orari di inizio per data  →  { "YYYY-MM-DD": ["16:30", ...] }
      const occupati = {};
      for (const ev of (r.body.items || [])) {
        const start = ev.start?.dateTime;
        if (!start) continue;
        const d = start.slice(0, 10);
        const t = start.slice(11, 16);
        if (!occupati[d]) occupati[d] = [];
        occupati[d].push(t);
      }
      return json(res, 200, { occupati });
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /prenota ──────────────────────────────────────────────────────────
  if (req.method === "POST" && path === "/prenota") {
    try {
      const body  = await readBody(req);
      const token = await getAccessToken();

      const { titolo, inizio, fine, luogo, descrizione } = body;
      if (!titolo || !inizio || !fine) return json(res, 400, { error: "Dati mancanti" });

      const evento = {
        summary:     titolo,
        location:    luogo    || "",
        description: descrizione || "",
        start: { dateTime: inizio, timeZone: "Europe/Rome" },
        end:   { dateTime: fine,   timeZone: "Europe/Rome" },
        reminders: {
          useDefault: false,
          overrides:  [{ method: "popup", minutes: 60 }],
        },
      };

      const calId  = encodeURIComponent(CALENDAR_ID);
      const gcPath = `/calendar/v3/calendars/${calId}/events`;
      const r = await gcalRequest("POST", gcPath, token, evento);

      if (r.status === 200 || r.status === 201) {
        return json(res, 200, { successo: true, eventId: r.body.id });
      } else {
        return json(res, 502, { successo: false, error: r.body?.error?.message || "Errore Google" });
      }
    } catch(e) {
      return json(res, 500, { successo: false, error: e.message });
    }
  }

  // 404
  json(res, 404, { error: "Endpoint non trovato" });
});

server.listen(PORT, () => {
  console.log(`✅ Server avviato su porta ${PORT}`);
  console.log(`📅 Calendario: ${CALENDAR_ID}`);

  // ── Ping automatico ogni 10 minuti per evitare il sleep di Render ──────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    const pingUrl = new URL(`${RENDER_URL}/health`);
    const mod = pingUrl.protocol === "https:" ? https : http;
    const req = mod.get({
      hostname: pingUrl.hostname,
      path:     pingUrl.pathname,
      port:     pingUrl.port || (pingUrl.protocol === "https:" ? 443 : 80),
    }, (res) => {
      console.log(`🏓 Ping ${new Date().toLocaleTimeString("it-IT")} → ${res.statusCode}`);
    });
    req.on("error", (e) => console.log(`⚠️ Ping fallito: ${e.message}`));
    req.end();
  }, 10 * 60 * 1000); // ogni 10 minuti
  console.log(`🏓 Ping automatico attivo ogni 10 minuti`);
});
