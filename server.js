// server.js - Backend Google Calendar + Google Sheets
// Studio Legale Avv. Girolamo Ceci
const https  = require("https");
const http   = require("http");
const url    = require("url");
const crypto = require("crypto");

const CALENDAR_ID  = process.env.CALENDAR_ID   || "girolamo.ceci@gmail.com";
const SHEET_ID     = process.env.SHEET_ID       || "1W1rXA9U4UEpz6_4vcrQftxxvL0Ncp2TXdtOYhIYXX2g";
const PORT         = parseInt(process.env.PORT  || "3000");
const SA_EMAIL     = process.env.SA_EMAIL       || "";
const SA_PRIVATE_KEY = (process.env.SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// JWT per Service Account (accesso a Calendar + Sheets)
function createJWT(scope) {
  var now = Math.floor(Date.now()/1000);
  var header  = Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})).toString("base64url");
  var payload = Buffer.from(JSON.stringify({
    iss: SA_EMAIL, scope: scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now+3600, iat: now
  })).toString("base64url");
  var sign = crypto.createSign("RSA-SHA256");
  sign.update(header+"."+payload);
  var sig = sign.sign(SA_PRIVATE_KEY,"base64url");
  return header+"."+payload+"."+sig;
}

function getAccessToken(scope) {
  return new Promise(function(resolve, reject) {
    var jwt  = createJWT(scope);
    var body = "grant_type="+encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")+
               "&assertion="+encodeURIComponent(jwt);
    var options = {
      hostname:"oauth2.googleapis.com", path:"/token", method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}
    };
    var req = https.request(options, function(res) {
      var data="";
      res.on("data",function(c){data+=c;});
      res.on("end",function(){
        try {
          var j=JSON.parse(data);
          if(j.access_token){resolve(j.access_token);}
          else{reject(new Error(j.error_description||j.error||JSON.stringify(j)));}
        } catch(e){reject(e);}
      });
    });
    req.on("error",reject);
    req.write(body); req.end();
  });
}

function apiRequest(hostname, path, method, token, body) {
  return new Promise(function(resolve, reject) {
    var bodyStr = body ? JSON.stringify(body) : "";
    var headers = {"Authorization":"Bearer "+token,"Content-Type":"application/json"};
    if(bodyStr){headers["Content-Length"]=Buffer.byteLength(bodyStr);}
    var req = https.request(
      {hostname:hostname, path:path, method:method, headers:headers},
      function(res) {
        var data="";
        res.on("data",function(c){data+=c;});
        res.on("end",function(){
          try{resolve({status:res.statusCode,body:JSON.parse(data)});}
          catch(e){resolve({status:res.statusCode,body:data});}
        });
      }
    );
    req.on("error",reject);
    if(bodyStr){req.write(bodyStr);}
    req.end();
  });
}

function gcalRequest(method, path, token, body) {
  return apiRequest("www.googleapis.com", path, method, token, body);
}

function sheetsRequest(method, path, token, body) {
  return apiRequest("sheets.googleapis.com", path, method, token, body);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
}

function sendJson(res, code, obj) {
  res.writeHead(code,{"Content-Type":"application/json"});
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function(resolve) {
    var data="";
    req.on("data",function(c){data+=c;});
    req.on("end",function(){
      try{resolve(JSON.parse(data));}catch(e){resolve({});}
    });
  });
}

// Scrivi riga su Google Sheet
async function scriviSuSheet(rigaDati) {
  try {
    var token = await getAccessToken("https://www.googleapis.com/auth/spreadsheets");
    var path  = "/v4/spreadsheets/"+SHEET_ID+"/values/Foglio1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
    await sheetsRequest("POST", path, token, {
      values: [rigaDati]
    });
  } catch(e) {
    console.log("ERRORE SHEET DETTAGLIO: "+e.message+" | "+JSON.stringify(e));
  }
}

// Aggiorna stato su Sheet (per annullamenti)
async function aggiornaStatoSheet(eventId, nuovoStato) {
  try {
    var token = await getAccessToken("https://www.googleapis.com/auth/spreadsheets");
    // Leggi tutti i dati per trovare la riga con l'eventId
    var path = "/v4/spreadsheets/"+SHEET_ID+"/values/Foglio1!A:M";
    var r = await sheetsRequest("GET", path, token, null);
    var rows = (r.body.values || []);
    for (var i=1; i<rows.length; i++) {
      if (rows[i][10] === eventId) { // colonna K = ID Evento
        var cella = "Foglio1!J"+(i+1); // colonna J = Stato
        var pathUpd = "/v4/spreadsheets/"+SHEET_ID+"/values/"+encodeURIComponent(cella)+"?valueInputOption=USER_ENTERED";
        await sheetsRequest("PUT", pathUpd, token, { values: [[nuovoStato]] });
        break;
      }
    }
  } catch(e) {
    console.log("Errore aggiornamento Sheet: "+e.message);
  }
}

var server = http.createServer(async function(req, res) {
  setCors(res);
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  var parsed = url.parse(req.url,true);
  var path   = parsed.pathname;

  // GET /health
  if(req.method==="GET" && path==="/health"){
    return sendJson(res,200,{ok:true,calendar:CALENDAR_ID,sa:SA_EMAIL});
  }

  // GET /debug
  if(req.method==="GET" && path==="/debug"){
    try {
      var token = await getAccessToken("https://www.googleapis.com/auth/calendar");
      var now=new Date().toISOString();
      var fin=new Date(); fin.setDate(fin.getDate()+3);
      var calId=encodeURIComponent(CALENDAR_ID);
      var gPath="/calendar/v3/calendars/"+calId+"/events"+
        "?timeMin="+encodeURIComponent(now)+"&timeMax="+encodeURIComponent(fin.toISOString())+"&maxResults=3&singleEvents=true";
      var r=await gcalRequest("GET",gPath,token,null);
      return sendJson(res,200,{tokenOk:true,gcalStatus:r.status,body:r.body});
    } catch(e){return sendJson(res,200,{tokenOk:false,error:e.message});}
  }

  // GET /eventi?da=YYYY-MM-DD
  if(req.method==="GET" && path==="/eventi"){
    try {
      var token = await getAccessToken("https://www.googleapis.com/auth/calendar");
      var da = parsed.query.da||new Date().toISOString().slice(0,10);
      var fine=new Date(da); fine.setDate(fine.getDate()+35);
      var a=fine.toISOString().slice(0,10);
      var calId=encodeURIComponent(CALENDAR_ID);
      var gPath="/calendar/v3/calendars/"+calId+"/events"+
        "?timeMin="+encodeURIComponent(da+"T00:00:00Z")+
        "&timeMax="+encodeURIComponent(a+"T23:59:59Z")+
        "&singleEvents=true&orderBy=startTime&maxResults=200";
      var r=await gcalRequest("GET",gPath,token,null);
      if(r.status!==200){return sendJson(res,502,{error:"Errore Google Calendar",detail:r.body});}
      var occupati={};
      var items=r.body.items||[];
      for(var i=0;i<items.length;i++){
        var ev=items[i];
        var start=ev.start&&ev.start.dateTime;
        if(!start) continue;
        var d=start.slice(0,10);
        var t=start.slice(11,16);
        if(!occupati[d]){occupati[d]=[];}
        occupati[d].push(t);
      }
      return sendJson(res,200,{occupati:occupati});
    } catch(e){return sendJson(res,500,{error:e.message});}
  }

  // POST /prenota
  if(req.method==="POST" && path==="/prenota"){
    try {
      var body  = await readBody(req);
      var token = await getAccessToken("https://www.googleapis.com/auth/calendar");
      if(!body.titolo||!body.inizio||!body.fine){return sendJson(res,400,{error:"Dati mancanti"});}

      var evento = {
        summary:     body.titolo,
        location:    body.luogo||"",
        description: body.descrizione||"",
        start:{dateTime:body.inizio,timeZone:"Europe/Rome"},
        end:  {dateTime:body.fine,  timeZone:"Europe/Rome"},
        reminders:{
          useDefault:false,
          overrides:[
            {method:"popup", minutes:60},        // 1 ora prima
            {method:"popup", minutes:1440},       // 1 giorno prima
            {method:"email", minutes:1440},       // email 1 giorno prima
          ]
        }
      };

      var calId=encodeURIComponent(CALENDAR_ID);
      var r=await gcalRequest("POST","/calendar/v3/calendars/"+calId+"/events",token,evento);
      if(r.status===200||r.status===201){
        var eventId = r.body.id||"";
        // Scrivi su Google Sheet
        var ora = body.inizio ? body.inizio.slice(11,16) : "";
        var oggi = new Date().toLocaleDateString("it-IT");
        await scriviSuSheet([
          body.dataLeggibile||"",   // A - Data
          body.orario||ora,          // B - Orario
          body.sede||"",             // C - Sede
          body.nome||"",             // D - Nome
          body.cognome||"",          // E - Cognome
          body.telefono||"",         // F - Telefono
          body.email||"",            // G - Email
          body.materia||"",          // H - Materia
          body.note||"",             // I - Note
          "Confermato",              // J - Stato
          eventId,                   // K - ID Evento
          oggi,                      // L - Data prenotazione
        ]);
        return sendJson(res,200,{successo:true,eventId:eventId});
      }
      return sendJson(res,502,{successo:false,error:(r.body&&r.body.error&&r.body.error.message)||"Errore Google"});
    } catch(e){return sendJson(res,500,{successo:false,error:e.message});}
  }

  // GET /cerca-prenotazioni?email=xxx
  if(req.method==="GET" && path==="/cerca-prenotazioni"){
    try {
      var email = parsed.query.email||"";
      if(!email){return sendJson(res,400,{error:"Email mancante"});}
      var token = await getAccessToken("https://www.googleapis.com/auth/calendar");
      var ora   = new Date().toISOString();
      var fin   = new Date(); fin.setDate(fin.getDate()+60);
      var calId = encodeURIComponent(CALENDAR_ID);
      var gPath = "/calendar/v3/calendars/"+calId+"/events"+
        "?timeMin="+encodeURIComponent(ora)+
        "&timeMax="+encodeURIComponent(fin.toISOString())+
        "&singleEvents=true&orderBy=startTime&maxResults=50&q="+encodeURIComponent(email);
      var r = await gcalRequest("GET",gPath,token,null);
      var eventi = [];
      var items  = (r.body.items||[]);
      for(var i=0;i<items.length;i++){
        var ev = items[i];
        if(ev.description && ev.description.includes(email)){
          var start = ev.start&&ev.start.dateTime;
          if(!start) continue;
          var d = new Date(start);
          eventi.push({
            id:     ev.id,
            data:   d.toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long",year:"numeric"}),
            orario: start.slice(11,16),
            sede:   ev.location||"",
            materia:ev.summary||"",
          });
        }
      }
      return sendJson(res,200,{eventi:eventi});
    } catch(e){return sendJson(res,500,{error:e.message});}
  }

  // POST /annulla
  if(req.method==="POST" && path==="/annulla"){
    try {
      var body  = await readBody(req);
      var token = await getAccessToken("https://www.googleapis.com/auth/calendar");
      var eventId = body.eventId;
      var email   = body.email;
      if(!eventId){return sendJson(res,400,{error:"ID evento mancante"});}
      var calId = encodeURIComponent(CALENDAR_ID);
      var r = await gcalRequest("DELETE","/calendar/v3/calendars/"+calId+"/events/"+eventId,token,null);
      if(r.status===204||r.status===200){
        await aggiornaStatoSheet(eventId,"Annullato");
        return sendJson(res,200,{successo:true});
      }
      return sendJson(res,502,{successo:false,error:"Impossibile annullare l'evento"});
    } catch(e){return sendJson(res,500,{successo:false,error:e.message});}
  }

  sendJson(res,404,{error:"Endpoint non trovato"});
});

server.listen(PORT, function() {
  console.log("Server avviato su porta "+PORT);
  console.log("Calendario: "+CALENDAR_ID);
  console.log("Sheet ID: "+SHEET_ID);
  console.log("Service Account: "+SA_EMAIL);

  var RENDER_URL = process.env.RENDER_EXTERNAL_URL||("http://localhost:"+PORT);
  setInterval(function(){
    try {
      var pingUrl = new URL(RENDER_URL+"/health");
      var mod = pingUrl.protocol==="https:"?https:http;
      var r = mod.get({
        hostname:pingUrl.hostname, path:"/health",
        port:pingUrl.port||(pingUrl.protocol==="https:"?443:80)
      },function(res){
        console.log("Ping "+new Date().toLocaleTimeString("it-IT")+" -> "+res.statusCode);
      });
      r.on("error",function(e){console.log("Ping fallito: "+e.message);});
      r.end();
    } catch(e){console.log("Ping error: "+e.message);}
  }, 10*60*1000);
  console.log("Ping automatico attivo ogni 10 minuti");
});
