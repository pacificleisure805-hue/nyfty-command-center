const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { randomUUID } = require('crypto');

const PORT        = process.env.PORT || 3457;
const AGENT_URL   = (process.env.NYFTY_AGENT_URL || 'https://nyfty-lending-agent.onrender.com').replace(/\/$/, '');
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'nyftycc2026';
const PUBLIC_DIR  = path.join(__dirname, 'public');

// ── Persistent local store (notes + pipeline stages) ──────────────────────────
const DATA_DIR     = process.env.RENDER ? '/data' : path.join(__dirname, 'data');
let NOTES_FILE     = path.join(__dirname, 'data', 'notes.json');
let PIPELINE_FILE  = path.join(__dirname, 'data', 'pipeline.json');

(function resolveDataDir() {
  let dir = path.join(__dirname, 'data');
  if (process.env.RENDER) {
    try {
      fs.writeFileSync('/data/.test', 'ok');
      fs.unlinkSync('/data/.test');
      dir = '/data';
      console.log('Persistent disk: /data');
    } catch(e) { console.log('No persistent disk, using repo data/'); }
  }
  NOTES_FILE    = path.join(dir, 'notes.json');
  PIPELINE_FILE = path.join(dir, 'pipeline.json');
  // Ensure data directory exists (no persistent disk on Render free tier)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(NOTES_FILE))    fs.writeFileSync(NOTES_FILE,    '{}');
  if (!fs.existsSync(PIPELINE_FILE)) fs.writeFileSync(PIPELINE_FILE, '{}');
  console.log('Data dir:', dir);
})();

function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return def; } }
function saveJSON(f, d)   { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

// ── Proxy fetch from NYFTY agent ──────────────────────────────────────────────
function agentFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const full = AGENT_URL + urlPath;
    const mod  = full.startsWith('https') ? https : require('http');
    mod.get(full, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Bad JSON from agent: ' + data.slice(0,100))); }
      });
    }).on('error', reject);
  });
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
function callOpenAI(messages) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_KEY) return reject(new Error('No OpenAI key configured'));
    const body = JSON.stringify({ model: 'gpt-4o', messages, temperature: 0.7, max_tokens: 600 });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  'Bearer ' + OPENAI_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.error) reject(new Error(p.error.message));
          else resolve(p.choices[0].message.content);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Merge CRM records with local pipeline/notes ───────────────────────────────
function enrichRecords(records) {
  const pipeline = loadJSON(PIPELINE_FILE, {});
  const notes    = loadJSON(NOTES_FILE, {});
  return records.map(r => ({
    ...r,
    stage:    pipeline[r.id] || 'New Lead',
    notes:    notes[r.id]    || [],
    priority: (!pipeline[r.id] || pipeline[r.id] === 'New Lead') ? 'high' : 'normal'
  }));
}

// ── Body reader ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };

// ── Request Handler ───────────────────────────────────────────────────────────
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const p   = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  function json(code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/health') {
    return json(200, {
      status: 'ok',
      agentUrl: AGENT_URL,
      openai: !!OPENAI_KEY,
      dataDir: NOTES_FILE.replace('/notes.json','')
    });
  }

  // ── Admin login ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    if (body.password === ADMIN_PASS) return json(200, { ok: true });
    return json(401, { error: 'Invalid password' });
  }

  // ── CRM records (proxied + enriched) ────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/crm') {
    try {
      const records = await agentFetch('/api/crm');
      return json(200, enrichRecords(records));
    } catch(e) {
      return json(502, { error: 'Could not reach NYFTY agent: ' + e.message });
    }
  }

  // ── Pipeline stats ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/stats') {
    try {
      const [rawRecords, health] = await Promise.all([
        agentFetch('/api/crm'),
        agentFetch('/api/health')
      ]);
      // enrichRecords merges local pipeline stages — critical for accurate stats
      const enriched = enrichRecords(rawRecords);
      const stages = ['New Lead','Contacted','In Progress','Closed Won','Closed Lost'];
      const byStage = {};
      stages.forEach(s => byStage[s] = enriched.filter(r => r.stage === s).length);
      const today = new Date().toDateString();
      return json(200, {
        totalLeads:    enriched.length,
        newLeads:      byStage['New Lead']    || 0,
        inProgress:    byStage['In Progress'] || 0,
        closedWon:     byStage['Closed Won']  || 0,
        closedLost:    byStage['Closed Lost'] || 0,
        contacted:     byStage['Contacted']   || 0,
        activeToday:   health.activeToday     || 0,
        totalChats:    health.totalConversations || 0,
        byStage
      });
    } catch(e) {
      return json(502, { error: e.message });
    }
  }

  // ── Update stage ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/stage') {
    const body = await readBody(req);
    const { id, stage } = body;
    if (!id || !stage) return json(400, { error: 'id and stage required' });
    const pipeline = loadJSON(PIPELINE_FILE, {});
    pipeline[id] = stage;
    saveJSON(PIPELINE_FILE, pipeline);
    return json(200, { ok: true, id, stage });
  }

  // ── Add note ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/note') {
    const body = await readBody(req);
    const { id, text, author } = body;
    if (!id || !text) return json(400, { error: 'id and text required' });
    const notes = loadJSON(NOTES_FILE, {});
    if (!notes[id]) notes[id] = [];
    notes[id].push({ id: randomUUID().slice(0,8), text, author: author || 'Loan Officer', createdAt: new Date().toISOString() });
    saveJSON(NOTES_FILE, notes);
    return json(200, { ok: true, notes: notes[id] });
  }

  // ── AI chat about a contact ───────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/chat') {
    const body = await readBody(req);
    const { message, contactId, history } = body;
    if (!message) return json(400, { error: 'message required' });

    let contactCtx = '';
    if (contactId) {
      try {
        const records = await agentFetch('/api/crm');
        const enriched = enrichRecords(records);
        const contact  = enriched.find(r => r.id === contactId);
        if (contact) {
          contactCtx = `\n\nCurrent contact context:\nName: ${contact.borrowerName}\nStage: ${contact.stage}\nTopics: ${(contact.topics||[]).join(', ')}\nMessages: ${contact.messageCount}\nSummary: ${contact.summary || 'No summary yet'}\nNotes: ${(contact.notes||[]).map(n => n.text).join(' | ') || 'None'}`;
        }
      } catch(e) { /* continue without context */ }
    }

    const systemPrompt = `You are Jordan, the NYFTY Lending AI assistant, now helping a Senior Loan Officer in the Command Center. You have access to CRM data and can help the LO understand leads, suggest next steps, draft follow-up messages, and answer questions about loan programs.

NYFTY Lending: Purchase, Refinance, Renovation, Commercial, Investment, HELOC, Roof Loans, Solar Financing. 12-day avg closing. Fiduciary lender.

Be concise, actionable, and professional. Help the LO close deals.${contactCtx}`;

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-8),
      { role: 'user', content: message }
    ];

    try {
      const reply = await callOpenAI(msgs);
      return json(200, { response: reply });
    } catch(e) {
      return json(500, { error: e.message });
    }
  }

  // ── Morning brief ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/brief') {
    try {
      const records  = await agentFetch('/api/crm');
      const enriched = enrichRecords(records);
      const newLeads  = enriched.filter(r => r.stage === 'New Lead');
      const inProg    = enriched.filter(r => r.stage === 'In Progress');
      const contacted = enriched.filter(r => r.stage === 'Contacted');
      const priorities = [];
      newLeads.slice(0,3).forEach(r => priorities.push({
        icon: '🔔', text: `New lead: ${r.borrowerName || 'Unknown'}`,
        sub: `Topics: ${(r.topics||[]).join(', ') || 'General inquiry'} · ${r.messageCount} messages`,
        type: 'new', id: r.id
      }));
      contacted.slice(0,2).forEach(r => priorities.push({
        icon: '📞', text: `Follow up with ${r.borrowerName || 'Unknown'}`,
        sub: `Stage: Contacted · ${(r.topics||[]).join(', ') || ''}`,
        type: 'followup', id: r.id
      }));
      inProg.slice(0,2).forEach(r => priorities.push({
        icon: '⚡', text: `Move ${r.borrowerName || 'Unknown'} forward`,
        sub: `In Progress · ${(r.notes||[]).length} notes`,
        type: 'progress', id: r.id
      }));
      return json(200, {
        date: new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }),
        totalNew: newLeads.length,
        totalActive: inProg.length + contacted.length,
        priorities: priorities.slice(0, 6)
      });
    } catch(e) {
      return json(502, { error: e.message });
    }
  }

  // ── Static files ──────────────────────────────────────────────────────────────
  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    return res.end(fs.readFileSync(filePath));
  }
  res.writeHead(404); res.end('Not found');
}

const server = http.createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error('Unhandled:', err.message);
    res.writeHead(500); res.end('Internal Server Error');
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('NYFTY Command Center running on port ' + PORT));
