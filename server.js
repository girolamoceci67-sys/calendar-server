// server.js - Backend Google Calendar - Studio Legale Avv. Ceci
const https = require("https");
const http  = require("http");
const url   = require("url");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const CALENDAR_ID   = process.env.CALENDAR_ID          || "girolamo.ceci@gmail.com";
const PORT          = parseInt(process.env.PORT         || "3000");

function getAccessToken() {
  return new Promise(function(resolve, reject) {
    var body = [
      "client_id="     + encodeURIComponent(CLIENT_ID),
      "client_secret=" + encodeURIComponent(CLIENT_SECRET),
      "refresh_token=" + encodeURIComponent(REFRESH_TOKEN),
      "grant_type=refresh_token"
    ].join("&");
    var options = {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var j = JSON.parse(data);
          if (j.access_token) { resolve(j.access_token); }
          else { reject(new Error(j.error_description || j.error || "Token error")); }
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function gcalRequest(method, gcPath, token, body) {
  return new Promise(function(resolve, reject) {
    var bodyStr = body ? JSON.stringify(body) : "";
    var headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
    if (bodyStr) { headers["Content-Length"] = Buffer.byteLength(bodyStr); }
    var req = https.request(
      { hostname: "www.googleapis.com", path: gcPath, method: method, headers: headers },
      function(res) {
        var data = "";
        res.on("data", function(c) { data += c; });
        res.on("end", function() {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch(e) { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) { req.write(bodyStr); }
    req.end();
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function(resolve) {
    var data = "";
    req.on("data", function(c) { data += c; });
    req.on("end", function() {
      try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
    });
  });
}

var server = http.createServer(async function(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  var parsed = url.parse(req.url, true);
  var path   = parsed.pathname;

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true, calendar: CALENDAR_ID });
  }

  if (req.method === "GET" && path === "/debug") {
    try {
      var token = await getAccessToken();
      var now  = new Date().toISOString();
      var fin  = new Date(); fin.setDate(fin.getDate() + 3);
      var calId = encodeURIComponent(CALENDAR_ID);
      var gPath = "/calendar/v3/calendars/" + calId + "/events" +
        "?timeMin=" + encodeURIComponent(now) +
        "&timeMax=" + encodeURIComponent(fin.toISOString()) +
        "&maxResults=3&singleEvents=true";
      var r = await gcalRequest("GET", gPath, token, null);
      return sendJson(res, 200, { tokenOk: true, gcalStatus: r.status, body: r.body });
    } catch(e) {
      return sendJson(res, 200, { tokenOk: false, error: e.message });
    }
  }

  if (req.method === "GET" && path === "/eventi") {
    try {
      var token = await getAccessToken();
      var da   = parsed.query.da || new Date().toISOString().slice(0,10);
      var fine = new Date(da); fine.setDate(fine.getDate() + 35);
      var a    = fine.toISOString().slice(0,10);
      var calId = encodeURIComponent(CALENDAR_ID);
      var gPath = "/calendar/v3/calendars/" + calId + "/events" +
        "?timeMin=" + encodeURIComponent(da + "T00:00:00Z") +
        "&timeMax=" + encodeURIComponent(a  + "T23:59:59Z") +
        "&singleEvents=true&orderBy=startTime&maxResults=200";
      var r = await gcalRequest("GET", gPath, token, null);
      if (r.status !== 200) { return sendJson(res, 502, { error: "Errore Google Calendar", detail: r.body }); }
      var occupati = {};
      var items = r.body.items || [];
      for (var i = 0; i < items.length; i++) {
        var ev = items[i];
        var start = ev.start && ev.start.dateTime;
        if (!start) continue;
        var d = start.slice(0,10);
        var t = start.slice(11,16);
        if (!occupati[d]) { occupati[d] = []; }
        occupati[d].push(t);
      }
      return sendJson(res, 200, { occupati: occupati });
    } catch(e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === "POST" && path === "/prenota") {
    try {
      var body  = await readBody(req);
      var token = await getAccessToken();
      if (!body.titolo || !body.inizio || !body.fine) {
        return sendJson(res, 400, { error: "Dati mancanti" });
      }
      var evento = {
        summary: body.titolo, location: body.luogo || "",
        description: body.descrizione || "",
        start: { dateTime: body.inizio, timeZone: "Europe/Rome" },
        end:   { dateTime: body.fine,   timeZone: "Europe/Rome" },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] }
      };
      var calId = encodeURIComponent(CALENDAR_ID);
      var r = await gcalRequest("POST", "/calendar/v3/calendars/" + calId + "/events", token, evento);
      if (r.status === 200 || r.status === 201) {
        return sendJson(res, 200, { successo: true, eventId: r.body.id });
      }
      return sendJson(res, 502, { successo: false, error: (r.body && r.body.error && r.body.error.message) || "Errore Google" });
    } catch(e) {
      return sendJson(res, 500, { successo: false, error: e.message });
    }
  }

  sendJson(res, 404, { error: "Endpoint non trovato" });
});

server.listen(PORT, function() {
  console.log("Server avviato su porta " + PORT);
  console.log("Calendario: " + CALENDAR_ID);
  var RENDER_URL = process.env.RENDER_EXTERNAL_URL || ("http://localhost:" + PORT);
  setInterval(function() {
    try {
      var pingUrl = new URL(RENDER_URL + "/health");
      var mod = pingUrl.protocol === "https:" ? https : http;
      var r = mod.get({ hostname: pingUrl.hostname, path: "/health", port: pingUrl.port || (pingUrl.protocol === "https:" ? 443 : 80) }, function(res) {
        console.log("Ping " + new Date().toLocaleTimeString("it-IT") + " -> " + res.statusCode);
      });
      r.on("error", function(e) { console.log("Ping fallito: " + e.message); });
      r.end();
    } catch(e) { console.log("Ping error: " + e.message); }
  }, 10 * 60 * 1000);
  console.log("Ping automatico attivo ogni 10 minuti");
});
