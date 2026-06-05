const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'resi.db');

let db;

// ── Helpers ───────────────────────────────────────────────────────────────────
function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function run(sql, params = []) { db.run(sql, params); saveDB(); }
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function queryOne(sql, params = []) { return queryAll(sql, params)[0] || null; }

const sessions = {};
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim());
  const tc = cookie.find(c => c.startsWith('token='));
  if (!tc) return null;
  const session = sessions[tc.split('=')[1]];
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

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  const SQL = await require('sql.js')();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, nama TEXT NOT NULL,
      role TEXT DEFAULT 'standard', status TEXT DEFAULT 'pending', createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS resi (
      id INTEGER PRIMARY KEY, noResi TEXT,
      kirimNama TEXT, kirimAlamat TEXT, kirimHp TEXT,
      terimaNama TEXT, terimaAlamat TEXT, terimaHp TEXT,
      barangDesc TEXT, barangBerat TEXT, barangKoli TEXT, barangCatatan TEXT,
      tanggal TEXT, status TEXT DEFAULT 'pending',
      createdById INTEGER, createdByNama TEXT
    );
    CREATE TABLE IF NOT EXISTS resi_tracking (
      id INTEGER PRIMARY KEY, resiId INTEGER,
      status TEXT, keterangan TEXT, lokasi TEXT,
      waktu TEXT, updatedById INTEGER, updatedByNama TEXT
    );
  `);
  saveDB();

  // Upgrade: tambah kolom status kalau belum ada
  try { db.run("ALTER TABLE resi ADD COLUMN status TEXT DEFAULT 'pending'"); saveDB(); } catch {}

  // Admin default
  if (!queryOne('SELECT id FROM users WHERE username = ?', ['admin'])) {
    run(`INSERT INTO users (id,username,password,nama,role,status,createdAt) VALUES (?,?,?,?,'admin','approved',?)`,
      [1, 'admin', hash('admin123'), 'Administrator', new Date().toLocaleString('id-ID')]);
    console.log('  👤 Admin dibuat: username=admin password=admin123');
  }

  // Migrasi dari JSON lama
  const DATA_FILE = path.join(__dirname, 'data.json');
  const USERS_FILE = path.join(__dirname, 'users.json');
  if (fs.existsSync(DATA_FILE)) {
    try {
      JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).forEach(r => {
        try {
          run(`INSERT OR IGNORE INTO resi (id,noResi,kirimNama,kirimAlamat,kirimHp,terimaNama,terimaAlamat,terimaHp,barangDesc,barangBerat,barangKoli,barangCatatan,tanggal,status,createdById,createdByNama)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [r.id,r.noResi||'',r.kirimNama||'',r.kirimAlamat||'',r.kirimHp||'',
             r.terimaNama||'',r.terimaAlamat||'',r.terimaHp||'',
             r.barangDesc||'',r.barangBerat||'',r.barangKoli||'1',r.barangCatatan||'',
             r.tanggal||'',r.status||'pending',r.createdById||0,r.createdByNama||'']);
        } catch {}
      });
      fs.renameSync(DATA_FILE, DATA_FILE + '.migrated');
      console.log('  ✅ Migrasi data.json selesai');
    } catch(e) { console.log('  ⚠️', e.message); }
  }
  if (fs.existsSync(USERS_FILE)) {
    try {
      JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).forEach(u => {
        try {
          run(`INSERT OR IGNORE INTO users (id,username,password,nama,role,status,createdAt) VALUES (?,?,?,?,?,?,?)`,
            [u.id,u.username,u.password,u.nama,u.role||'standard',u.status,u.createdAt]);
        } catch {}
      });
      fs.renameSync(USERS_FILE, USERS_FILE + '.migrated');
      console.log('  ✅ Migrasi users.json selesai');
    } catch(e) { console.log('  ⚠️', e.message); }
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
async function startServer() {
  await initDB();

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const p = parsed.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/api/register') {
      const b = await bodyJSON(req);
      if (!b.username || !b.password || !b.nama) return json(res, 400, { ok: false, msg: 'Data tidak lengkap' });
      if (b.password.length < 6) return json(res, 400, { ok: false, msg: 'Password minimal 6 karakter' });
      if (queryOne('SELECT id FROM users WHERE username = ?', [b.username.trim()]))
        return json(res, 400, { ok: false, msg: 'Username sudah dipakai' });
      run(`INSERT INTO users (id,username,password,nama,role,status,createdAt) VALUES (?,?,?,?,'standard','pending',?)`,
        [Date.now(), b.username.trim(), hash(b.password), b.nama.trim(), new Date().toLocaleString('id-ID')]);
      return json(res, 201, { ok: true, msg: 'Registrasi berhasil, tunggu persetujuan admin.' });
    }

    if (req.method === 'POST' && p === '/api/login') {
      const b = await bodyJSON(req);
      const user = queryOne('SELECT * FROM users WHERE username = ? AND password = ?', [b.username, hash(b.password)]);
      if (!user) return json(res, 401, { ok: false, msg: 'Username atau password salah' });
      if (user.status === 'pending') return json(res, 403, { ok: false, msg: 'Akun belum disetujui admin' });
      if (user.status === 'rejected') return json(res, 403, { ok: false, msg: 'Akun ditolak admin' });
      const token = createSession(user.id);
      res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return json(res, 200, { ok: true, user: { id: user.id, nama: user.nama, role: user.role, username: user.username } });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const tc = (req.headers.cookie || '').split(';').map(s => s.trim()).find(c => c.startsWith('token='));
      if (tc) delete sessions[tc.split('=')[1]];
      res.setHeader('Set-Cookie', 'token=; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/me') {
      const user = getSession(req);
      if (!user) return json(res, 401, { ok: false });
      return json(res, 200, { ok: true, user: { id: user.id, nama: user.nama, role: user.role, username: user.username } });
    }

    // ── USERS (admin only) ────────────────────────────────────────────────────
    if (req.method === 'GET' && p === '/api/users') {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      return json(res, 200, queryAll('SELECT id,username,nama,role,status,createdAt FROM users ORDER BY id ASC'));
    }

    if (req.method === 'PUT' && p.match(/^\/api\/users\/\d+\/status$/)) {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      const id = parseInt(p.split('/')[3]);
      const b = await bodyJSON(req);
      run('UPDATE users SET status = ? WHERE id = ?', [b.status, id]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'PUT' && p.match(/^\/api\/users\/\d+\/role$/)) {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      const id = parseInt(p.split('/')[3]);
      if (id === me.id) return json(res, 400, { ok: false, msg: 'Tidak bisa ubah role diri sendiri' });
      const b = await bodyJSON(req);
      if (!['standard','operasional','admin'].includes(b.role))
        return json(res, 400, { ok: false, msg: 'Role tidak valid' });
      run('UPDATE users SET role = ? WHERE id = ?', [b.role, id]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.match(/^\/api\/users\/\d+$/) && p.startsWith('/api/users/')) {
      const me = getSession(req);
      if (!me || me.role !== 'admin') return json(res, 403, { ok: false });
      const id = parseInt(p.split('/')[3]);
      if (id === me.id) return json(res, 400, { ok: false, msg: 'Tidak bisa hapus diri sendiri' });
      run('DELETE FROM users WHERE id = ?', [id]);
      return json(res, 200, { ok: true });
    }

    // ── RESI ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && p === '/api/next-no') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const rows = queryAll("SELECT noResi FROM resi WHERE noResi LIKE ?", ['RES-' + today + '-%']);
      const max = rows.reduce((m, r) => {
        const parts = (r.noResi||'').split('-');
        return Math.max(m, parseInt(parts[parts.length-1])||0);
      }, 0);
      return json(res, 200, { noResi: 'RES-' + today + '-' + String(max+1).padStart(3,'0') });
    }

    if (req.method === 'GET' && p === '/api/resi') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      return json(res, 200, queryAll('SELECT * FROM resi ORDER BY id DESC'));
    }

    if (req.method === 'POST' && p === '/api/resi') {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role === 'standard') return json(res, 403, { ok: false, msg: 'Akun standard tidak bisa membuat resi' });
      const b = await bodyJSON(req);
      const id = Date.now();
      const tanggal = b.tanggal || new Date().toLocaleString('id-ID');
      run(`INSERT INTO resi (id,noResi,kirimNama,kirimAlamat,kirimHp,terimaNama,terimaAlamat,terimaHp,barangDesc,barangBerat,barangKoli,barangCatatan,tanggal,status,createdById,createdByNama)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        [id,b.noResi||'',b.kirimNama||'',b.kirimAlamat||'',b.kirimHp||'',
         b.terimaNama||'',b.terimaAlamat||'',b.terimaHp||'',
         b.barangDesc||'',b.barangBerat||'',b.barangKoli||'1',b.barangCatatan||'',
         tanggal,me.id,me.nama]);
      return json(res, 201, { ok: true, resi: { id, ...b, tanggal, status:'pending', createdById:me.id, createdByNama:me.nama } });
    }

    if (req.method === 'PUT' && p.match(/^\/api\/resi\/\d+$/) && p.startsWith('/api/resi/') && !p.includes('tracking')) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role === 'standard') return json(res, 403, { ok: false, msg: 'Akun standard tidak bisa edit resi' });
      const id = parseInt(p.split('/')[3]);
      const resi = queryOne('SELECT * FROM resi WHERE id = ?', [id]);
      if (!resi) return json(res, 404, { ok: false });
      if (me.role !== 'admin' && resi.createdById !== me.id)
        return json(res, 403, { ok: false, msg: 'Tidak bisa edit resi orang lain' });
      const b = await bodyJSON(req);
      run(`UPDATE resi SET kirimNama=?,kirimAlamat=?,kirimHp=?,terimaNama=?,terimaAlamat=?,terimaHp=?,barangDesc=?,barangBerat=?,barangKoli=?,barangCatatan=? WHERE id=?`,
        [b.kirimNama??resi.kirimNama, b.kirimAlamat??resi.kirimAlamat, b.kirimHp??resi.kirimHp,
         b.terimaNama??resi.terimaNama, b.terimaAlamat??resi.terimaAlamat, b.terimaHp??resi.terimaHp,
         b.barangDesc??resi.barangDesc, b.barangBerat??resi.barangBerat,
         b.barangKoli??resi.barangKoli, b.barangCatatan??resi.barangCatatan, id]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.match(/^\/api\/resi\/\d+$/) && p.startsWith('/api/resi/') && !p.includes('tracking')) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role !== 'admin') return json(res, 403, { ok: false, msg: 'Hanya admin yang bisa hapus resi' });
      const id = parseInt(p.split('/')[3]);
      run('DELETE FROM resi WHERE id = ?', [id]);
      run('DELETE FROM resi_tracking WHERE resiId = ?', [id]);
      return json(res, 200, { ok: true });
    }

    // ── TRACKING ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && p.match(/^\/api\/resi\/\d+\/tracking$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      const id = parseInt(p.split('/')[3]);
      return json(res, 200, queryAll('SELECT * FROM resi_tracking WHERE resiId = ? ORDER BY id ASC', [id]));
    }

    if (req.method === 'POST' && p.match(/^\/api\/resi\/\d+\/tracking$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role === 'standard') return json(res, 403, { ok: false, msg: 'Akun standard tidak bisa update tracking' });
      const id = parseInt(p.split('/')[3]);
      const resi = queryOne('SELECT * FROM resi WHERE id = ?', [id]);
      if (!resi) return json(res, 404, { ok: false });
      if (me.role !== 'admin' && resi.createdById !== me.id)
        return json(res, 403, { ok: false, msg: 'Hanya pembuat resi atau admin yang bisa update tracking' });
      const b = await bodyJSON(req);
      const waktu = new Date().toLocaleString('id-ID');
      const isAdmin = me.role === 'admin';
      const statusToSave = isAdmin ? (b.status||resi.status||'pending') : (resi.status||'pending');
      run(`INSERT INTO resi_tracking (id,resiId,status,keterangan,lokasi,waktu,updatedById,updatedByNama) VALUES (?,?,?,?,?,?,?,?)`,
        [Date.now(), id, statusToSave, b.keterangan||'', b.lokasi||'', waktu, me.id, me.nama]);
      if (isAdmin) run('UPDATE resi SET status = ? WHERE id = ?', [b.status, id]);
      return json(res, 201, { ok: true });
    }

    if (req.method === 'PUT' && p.match(/^\/api\/tracking\/\d+$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role === 'standard') return json(res, 403, { ok: false });
      const trackId = parseInt(p.split('/')[3]);
      const track = queryOne('SELECT * FROM resi_tracking WHERE id = ?', [trackId]);
      if (!track) return json(res, 404, { ok: false });
      const resi = queryOne('SELECT * FROM resi WHERE id = ?', [track.resiId]);
      if (!resi) return json(res, 404, { ok: false });
      if (me.role !== 'admin' && resi.createdById !== me.id) return json(res, 403, { ok: false });
      const b = await bodyJSON(req);
      const isAdmin = me.role === 'admin';
      if (isAdmin && b.status) {
        run('UPDATE resi_tracking SET status=?,keterangan=?,lokasi=? WHERE id=?',
          [b.status, b.keterangan??track.keterangan, b.lokasi??track.lokasi, trackId]);
        const last = queryOne('SELECT * FROM resi_tracking WHERE resiId=? ORDER BY id DESC LIMIT 1', [track.resiId]);
        if (last && last.id === trackId) run('UPDATE resi SET status=? WHERE id=?', [b.status, track.resiId]);
      } else {
        run('UPDATE resi_tracking SET keterangan=?,lokasi=? WHERE id=?',
          [b.keterangan??track.keterangan, b.lokasi??track.lokasi, trackId]);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.match(/^\/api\/tracking\/\d+$/)) {
      const me = getSession(req);
      if (!me) return json(res, 401, { ok: false });
      if (me.role === 'standard') return json(res, 403, { ok: false });
      const trackId = parseInt(p.split('/')[3]);
      const track = queryOne('SELECT * FROM resi_tracking WHERE id = ?', [trackId]);
      if (!track) return json(res, 404, { ok: false });
      const resi = queryOne('SELECT * FROM resi WHERE id = ?', [track.resiId]);
      if (!resi) return json(res, 404, { ok: false });
      if (me.role !== 'admin' && resi.createdById !== me.id) return json(res, 403, { ok: false });
      run('DELETE FROM resi_tracking WHERE id = ?', [trackId]);
      const last = queryOne('SELECT * FROM resi_tracking WHERE resiId=? ORDER BY id DESC LIMIT 1', [track.resiId]);
      run('UPDATE resi SET status=? WHERE id=?', [last ? last.status : 'pending', track.resiId]);
      return json(res, 200, { ok: true });
    }

    // ── STATIC FILES ──────────────────────────────────────────────────────────
    let filePath = path.join(__dirname, p === '/' ? 'index.html' : p);
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
      res.end(content);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ✅ Server berjalan! http://localhost:' + PORT);
    console.log('  👤 Login admin: username=admin  password=admin123\n');
  });
}

startServer().catch(console.error);
