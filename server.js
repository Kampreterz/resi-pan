const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ── Database setup (sql.js - pure JS, no build tools needed) ─────────────────
const initSqlJs = require('sql.js');

const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'resi.db');

let db;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nama TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'pending',
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS resi (
      id INTEGER PRIMARY KEY,
      noResi TEXT,
      kirimNama TEXT, kirimAlamat TEXT, kirimHp TEXT,
      terimaNama TEXT, terimaAlamat TEXT, terimaHp TEXT,
      barangDesc TEXT, barangBerat TEXT, barangKoli TEXT, barangCatatan TEXT,
      tanggal TEXT,
      createdById INTEGER,
      createdByNama TEXT
    );
  `);

  saveDB();

  // Buat admin default
  const adminExist = queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminExist) {
    run(`INSERT INTO users (id,username,password,nama,role,status,createdAt)
      VALUES (?,?,?,?,'admin','approved',?)`,
      [1, 'admin', hash('admin123'), 'Administrator', new Date().toLocaleString('id-ID')]);
    console.log('  👤 Akun admin dibuat: username=admin  password=admin123');
  }

  // Migrasi dari JSON lama
  const DATA_FILE = path.join(__dirname, 'data.json');
  const USERS_FILE = path.join(__dirname, 'users.json');

  if (fs.existsSync(DATA_FILE)) {
    try {
      const rows = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      rows.forEach(r => {
        try {
          run(`INSERT OR IGNORE INTO resi
            (id,noResi,kirimNama,kirimAlamat,kirimHp,terimaNama,terimaAlamat,terimaHp,
             barangDesc,barangBerat,barangKoli,barangCatatan,tanggal,createdById,createdByNama)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [r.id,r.noResi||'',r.kirimNama||'',r.kirimAlamat||'',r.kirimHp||'',
             r.terimaNama||'',r.terimaAlamat||'',r.terimaHp||'',
             r.barangDesc||'',r.barangBerat||'',r.barangKoli||'1',r.barangCatatan||'',
             r.tanggal||'',r.createdById||0,r.createdByNama||'']);
        } catch {}
      });
      saveDB();
      fs.renameSync(DATA_FILE, DATA_FILE + '.migrated');
      console.log(`  ✅ Migrasi ${rows.length} resi dari data.json`);
    } catch(e) { console.log('  ⚠️  Migrasi data.json gagal:', e.message); }
  }

  if (fs.existsSync(USERS_FILE)) {
    try {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      users.forEach(u => {
        try {
          run(`INSERT OR IGNORE INTO users (id,username,password,nama,role,status,createdAt)
            VALUES (?,?,?,?,?,?,?)`,
            [u.id,u.username,u.password,u.nama,u.role,u.status,u.createdAt]);
        } catch {}
      });
      saveDB();
      fs.renameSync(USERS_FILE, USERS_FILE + '.migrated');
      console.log(`  ✅ Migrasi ${users.length} user dari users.json`);
    } catch(e) { console.log('  ⚠️  Migrasi users.json gagal:', e.message); }
  }
}

// ── DB Helpers ────────────────────────────────────────────────────────────────
function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

const sessions = {};
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim());
  const tokenCookie = cookie.find(c => c.startsWith('token='));
  if (!tokenCookie) return null;
  const token = tokenCookie.split('=')[1];
  const session = sessions[token];
  if (!session) return null;
  return queryOne('SELECT * FROM users WHERE id = ?', [session.userId]);
}

function bodyJSON(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ────────────────────────────────────────────────────────────────────
async function startServer() {
  await initDB();

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // POST /api/register
    if (req.method === 'POST' && pathname === '/api/register') {
      const b = await bodyJSON(req);
      if (!b.username || !b.password || !b.nama) return json(res, 400, { ok: false, msg: 'Data tidak lengkap' });
      if (queryOne('SELECT id FROM users WHERE username = ?', [b.username.trim()]))
        return json(res, 400, { ok: false, msg: 'Username sudah dipakai' });
      run(`INSERT INTO users (id,username,password,nama,role,status,createdAt) VALUES (?,?,?,?,'user','pending',?)`,
        [Date.now(), b.username.trim(), hash(b.password), b.nama.trim(), new Date().toLocaleString('id-ID')]);
      return json(res, 201, { ok: true, msg: 'Registrasi berhasil, tunggu persetujuan admin.' });
    }

    // POST /api/login
    if (req.method === 'POST' && pathname === '/api/login') {
      const b = await bodyJSON(req);
      const user = queryOne('SELECT * FROM users WHERE username = ? AND password = ?', [b.username, hash(b.password)]);
      if (!user) return json(res, 401, { ok: false, msg: 'Username atau password salah' });
      if (user.status === 'pending') return json(res, 403, { ok: false, msg: 'Akun belum disetujui admin' });
      if (user.status === 'rejected') return json(res, 403, { ok: false, msg: 'Akun ditolak admin' });
      const token = createSession(user.id);
      res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return json(res, 200, { ok: true, user: { id: user.id, nama: user.nama, role: user.role, username: user.username } });
    }

    // POST /api/logout
    if (req.method === 'POST' && pathname === '/api/logout') {
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim());
      const tc = cookie.find(c => c.startsWith('token='));
      if (tc) delete sessions[tc.split('=')[1]];
      res.setHeader('Set-Cookie', 'token=; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    // GET /api/me
    if (req.method === 'GET' && pathname === '/api/me') {
      const user = getSession(req);
      if (!user) return json(res, 401, { ok: false });
      return json(res, 200, { ok: true, user: { id: user.id, nama: user.nama, role: user.role, username: user.username } });
    }

    // GET /api/users
    if (req.method === 'GET' && pathname === '/api/users') {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      return json(res, 200, queryAll('SELECT id,username,nama,role,status,createdAt FROM users ORDER BY id ASC'));
    }

    // PUT /api/users/:id/status
    if (req.method === 'PUT' && pathname.match(/^\/api\/users\/\d+\/status$/)) {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      const id = parseInt(pathname.split('/')[3]);
      const b = await bodyJSON(req);
      run('UPDATE users SET status = ? WHERE id = ?', [b.status, id]);
      return json(res, 200, { ok: true });
    }

    // DELETE /api/users/:id
    if (req.method === 'DELETE' && pathname.match(/^\/api\/users\/\d+$/) && pathname.startsWith('/api/users/')) {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      const id = parseInt(pathname.split('/')[3]);
      if (id === me.id) return json(res, 400, { ok: false, msg: 'Tidak bisa hapus diri sendiri' });
      run('DELETE FROM users WHERE id = ?', [id]);
      return json(res, 200, { ok: true });
    }

    // GET /api/next-no
    if (req.method === 'GET' && pathname === '/api/next-no') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const prefix = 'RES-' + today + '-';
      const rows = queryAll("SELECT noResi FROM resi WHERE noResi LIKE ?", [prefix + '%']);
      const maxUrut = rows.reduce((max, r) => {
        const parts = (r.noResi || '').split('-');
        return Math.max(max, parseInt(parts[parts.length - 1]) || 0);
      }, 0);
      return json(res, 200, { noResi: prefix + String(maxUrut + 1).padStart(3, '0') });
    }

    // GET /api/resi
    if (req.method === 'GET' && pathname === '/api/resi') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      return json(res, 200, queryAll('SELECT * FROM resi ORDER BY id DESC'));
    }

    // POST /api/resi
    if (req.method === 'POST' && pathname === '/api/resi') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const b = await bodyJSON(req);
      const id = Date.now();
      const tanggal = b.tanggal || new Date().toLocaleString('id-ID');
      run(`INSERT INTO resi (id,noResi,kirimNama,kirimAlamat,kirimHp,terimaNama,terimaAlamat,terimaHp,
           barangDesc,barangBerat,barangKoli,barangCatatan,tanggal,createdById,createdByNama)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,b.noResi||'',b.kirimNama||'',b.kirimAlamat||'',b.kirimHp||'',
         b.terimaNama||'',b.terimaAlamat||'',b.terimaHp||'',
         b.barangDesc||'',b.barangBerat||'',b.barangKoli||'1',b.barangCatatan||'',
         tanggal,me.id,me.nama]);
      return json(res, 201, { ok: true, resi: { id, ...b, tanggal, createdById: me.id, createdByNama: me.nama } });
    }

    // PUT /api/resi/:id
    if (req.method === 'PUT' && pathname.match(/^\/api\/resi\/\d+$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const id = parseInt(pathname.split('/')[3]);
      const resi = queryOne('SELECT * FROM resi WHERE id = ?', [id]);
      if (!resi) return json(res, 404, { ok: false });
      if (me.role !== 'admin' && resi.createdById !== me.id)
        return json(res, 403, { ok: false, msg: 'Tidak bisa edit resi orang lain' });
      const b = await bodyJSON(req);
      run(`UPDATE resi SET kirimNama=?,kirimAlamat=?,kirimHp=?,
           terimaNama=?,terimaAlamat=?,terimaHp=?,
           barangDesc=?,barangBerat=?,barangKoli=?,barangCatatan=? WHERE id=?`,
        [b.kirimNama??resi.kirimNama, b.kirimAlamat??resi.kirimAlamat, b.kirimHp??resi.kirimHp,
         b.terimaNama??resi.terimaNama, b.terimaAlamat??resi.terimaAlamat, b.terimaHp??resi.terimaHp,
         b.barangDesc??resi.barangDesc, b.barangBerat??resi.barangBerat,
         b.barangKoli??resi.barangKoli, b.barangCatatan??resi.barangCatatan, id]);
      return json(res, 200, { ok: true });
    }

    // DELETE /api/resi/:id
    if (req.method === 'DELETE' && pathname.match(/^\/api\/resi\/\d+$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const id = parseInt(pathname.split('/')[3]);
      if (me.role !== 'admin') return json(res, 403, { ok: false, msg: 'Hanya admin yang bisa menghapus resi' });
      run('DELETE FROM resi WHERE id = ?', [id]);
      return json(res, 200, { ok: true });
    }

    // Static files
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(content);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ✅ Server resi berjalan!');
    console.log('  🌐 http://localhost:' + PORT);
    console.log('  👤 Login admin: username=admin  password=admin123');
    console.log('');
  });
}

startServer().catch(console.error);
