'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const W = 3000, H = 900, LANE = 450, TICK = 30, DT = 1 / TICK;
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = v => (Number.isFinite(v) ? v : 0);
const r1 = v => Math.round(v);

let uid = 1;
const rooms = new Map();

function step(e, tx, ty, speed) {
  const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
  if (d < 1) return;
  const m = Math.min(d, speed * DT);
  e.x = clamp(e.x + (dx / d) * m, 20, W - 20);
  e.y = clamp(e.y + (dy / d) * m, 20, H - 20);
}

class Game {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.time = 0;
    this.started = false;
    this.winner = null;
    this.winAt = 0;
    this.nextWave = 0;
    this.ev = [];
    this.resetWorld();
    this.loop = setInterval(() => this.tick(), 1000 / TICK);
  }

  resetWorld() {
    this.minions = [];
    this.projs = [];
    this.structs = [];
    for (const team of [0, 1]) {
      const dir = team === 0 ? 1 : -1;
      const base = team === 0 ? 150 : W - 150;
      this.structs.push({ id: uid++, kind: 'nexus', team, x: base, y: LANE, hp: 3000, maxhp: 3000, r: 70 });
      for (const off of [500, 900]) {
        this.structs.push({ id: uid++, kind: 'tower', team, x: base + dir * off, y: LANE, hp: 1500, maxhp: 1500, r: 40, cd: 0 });
      }
    }
  }

  addPlayer(ws, name) {
    if (this.players.size >= 6) return null;
    let c0 = 0;
    for (const p of this.players.values()) if (p.team === 0) c0++;
    const c1 = this.players.size - c0;
    const team = c0 <= c1 ? 0 : 1;
    const p = {
      id: uid++, ws, name: (name || 'Oyuncu').slice(0, 14), team, kind: 'champ', r: 22, maxhp: 700,
      kills: 0, deaths: 0, cs: 0, respawn: 0, cdq: 0, cdw: 0, atk: 0,
    };
    this.spawn(p);
    this.players.set(p.id, p);
    return p;
  }

  spawn(p) {
    const base = p.team === 0 ? 150 : W - 150;
    p.x = base + (p.team === 0 ? 130 : -130);
    p.y = LANE + (Math.random() - 0.5) * 160;
    p.hp = p.maxhp;
    p.tx = p.x; p.ty = p.y;
    p.target = null;
    p.dead = false;
    p.respawn = 0;
  }

  targetable(t) {
    if (t.kind === 'nexus') return !this.structs.some(s => s.kind === 'tower' && s.team === t.team && s.hp > 0);
    return true;
  }

  byId(id) {
    if (this.players.has(id)) return this.players.get(id);
    return this.minions.find(m => m.id === id) || this.structs.find(s => s.id === id) || null;
  }

  nearest(e, range, lists) {
    let best = null, bd = range;
    for (const list of lists) {
      for (const t of list) {
        if (t.team === e.team || t.hp <= 0 || t.dead || !this.targetable(t)) continue;
        const d = dist(e, t) - t.r;
        if (d < bd) { best = t; bd = d; }
      }
    }
    return best;
  }

  hit(t, amt, src) {
    if (t.hp <= 0 || t.dead || !this.targetable(t)) return;
    t.hp -= amt;
    if (t.hp > 0) return;
    t.hp = 0;
    if (t.kind === 'champ') {
      t.dead = true; t.respawn = 6; t.deaths++; t.target = null;
      if (src && src.kind === 'champ') src.kills++;
    } else if (t.kind === 'minion') {
      if (src && src.kind === 'champ') src.cs++;
    } else if (t.kind === 'nexus' && this.winner === null) {
      this.winner = 1 - t.team;
      this.winAt = this.time;
    }
  }

  attack(src, t, dmg) {
    this.ev.push({ a: [r1(src.x), r1(src.y)], b: [r1(t.x), r1(t.y)], c: src.team, k: src.kind === 'tower' ? 1 : 0 });
    this.hit(t, dmg, src);
  }

  input(p, m) {
    if (p.dead || this.winner !== null) return;
    if (m.t === 'move') {
      p.target = null;
      p.tx = clamp(num(m.x), 0, W);
      p.ty = clamp(num(m.y), 0, H);
    } else if (m.t === 'atk') {
      p.target = num(m.id);
    } else if (m.t === 'q' && p.cdq <= 0) {
      let dx = num(m.x) - p.x, dy = num(m.y) - p.y, d = Math.hypot(dx, dy);
      if (d < 1) { dx = p.team === 0 ? 1 : -1; dy = 0; d = 1; }
      this.projs.push({ id: uid++, team: p.team, owner: p, x: p.x, y: p.y, vx: (dx / d) * 950, vy: (dy / d) * 950, left: 800, r: 18 });
      p.cdq = 4;
    } else if (m.t === 'w' && p.cdw <= 0) {
      let dx = num(m.x) - p.x, dy = num(m.y) - p.y, d = Math.hypot(dx, dy);
      if (d < 1) return;
      const len = Math.min(330, d);
      p.x = clamp(p.x + (dx / d) * len, 20, W - 20);
      p.y = clamp(p.y + (dy / d) * len, 20, H - 20);
      p.tx = p.x; p.ty = p.y;
      p.cdw = 7;
    }
  }

  spawnWave() {
    for (const team of [0, 1]) {
      const dir = team === 0 ? 1 : -1;
      const base = team === 0 ? 150 : W - 150;
      for (let i = 0; i < 3; i++) {
        this.minions.push({
          id: uid++, kind: 'minion', team, x: base + dir * (120 + i * 45), y: LANE + (i - 1) * 32,
          hp: 220, maxhp: 220, r: 14, atk: 0,
        });
      }
    }
  }

  reset() {
    this.resetWorld();
    this.winner = null;
    this.nextWave = this.time + 3;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.cs = 0; p.cdq = 0; p.cdw = 0; p.atk = 0;
      this.spawn(p);
    }
  }

  tick() {
    this.time += DT;
    this.ev = [];
    const champs = [...this.players.values()];

    if (this.winner !== null) {
      if (this.time - this.winAt > 8) this.reset();
      this.send();
      return;
    }

    if (!this.started && champs.some(p => p.team === 0) && champs.some(p => p.team === 1)) {
      this.started = true;
      this.nextWave = this.time + 3;
    }
    if (this.started && this.time >= this.nextWave) {
      this.spawnWave();
      this.nextWave += 22;
    }

    // Şampiyonlar
    for (const p of champs) {
      if (p.dead) {
        p.respawn -= DT;
        if (p.respawn <= 0) this.spawn(p);
        continue;
      }
      p.cdq = Math.max(0, p.cdq - DT);
      p.cdw = Math.max(0, p.cdw - DT);
      p.atk = Math.max(0, p.atk - DT);
      p.hp = Math.min(p.maxhp, p.hp + 8 * DT);

      let goal = null;
      if (p.target) {
        const t = this.byId(p.target);
        if (!t || t.hp <= 0 || t.dead || t.team === p.team || !this.targetable(t)) p.target = null;
        else goal = t;
      }
      if (goal) {
        if (dist(p, goal) <= 380 + goal.r) {
          if (p.atk <= 0) { this.attack(p, goal, 55); p.atk = 0.8; }
        } else {
          step(p, goal.x, goal.y, 300);
        }
      } else {
        step(p, p.tx, p.ty, 300);
      }
    }

    // Minyonlar
    for (const m of this.minions) {
      m.atk = Math.max(0, m.atk - DT);
      const foe = this.nearest(m, 320, [this.minions, champs, this.structs]);
      if (foe) {
        if (dist(m, foe) <= 90 + foe.r) {
          if (m.atk <= 0) { this.attack(m, foe, 14); m.atk = 1; }
        } else {
          step(m, foe.x, foe.y, 130);
        }
      } else {
        const dir = m.team === 0 ? 1 : -1;
        step(m, m.x + dir * 100, LANE + (m.y - LANE) * 0.5, 130);
      }
    }

    // Kuleler
    for (const s of this.structs) {
      if (s.kind !== 'tower' || s.hp <= 0) continue;
      s.cd = Math.max(0, s.cd - DT);
      if (s.cd > 0) continue;
      const t = this.nearest(s, 430, [this.minions]) || this.nearest(s, 430, [champs]);
      if (t) { this.attack(s, t, 65); s.cd = 1.3; }
    }

    // Oklar (Q)
    for (const q of this.projs) {
      q.x += q.vx * DT; q.y += q.vy * DT;
      q.left -= Math.hypot(q.vx, q.vy) * DT;
      let victim = null;
      for (const list of [this.minions, champs, this.structs]) {
        for (const t of list) {
          if (t.team === q.team || t.hp <= 0 || t.dead || !this.targetable(t)) continue;
          if (dist(q, t) < t.r + q.r) { victim = t; break; }
        }
        if (victim) break;
      }
      if (victim) { this.hit(victim, 110, q.owner); q.left = 0; }
      if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) q.left = 0;
    }
    this.projs = this.projs.filter(q => q.left > 0);
    this.minions = this.minions.filter(m => m.hp > 0);

    this.send();
  }

  snapshot() {
    const pl = [...this.players.values()].map(p => ({
      id: p.id, team: p.team, x: r1(p.x), y: r1(p.y), hp: r1(p.hp), mh: p.maxhp, d: p.dead ? 1 : 0,
      n: p.name, k: p.kills, de: p.deaths, cs: p.cs, cq: +p.cdq.toFixed(1), cw: +p.cdw.toFixed(1),
      rs: +Math.max(0, p.respawn).toFixed(1), r: p.r,
    }));
    const mn = this.minions.map(m => ({ id: m.id, team: m.team, x: r1(m.x), y: r1(m.y), hp: r1(m.hp), mh: m.maxhp, r: m.r }));
    const st = this.structs.map(s => ({
      id: s.id, team: s.team, k: s.kind, x: s.x, y: s.y, hp: r1(s.hp), mh: s.maxhp, r: s.r,
      p: s.kind === 'nexus' && !this.targetable(s) ? 1 : 0,
    }));
    const pr = this.projs.map(q => ({ id: q.id, team: q.team, x: r1(q.x), y: r1(q.y), a: +Math.atan2(q.vy, q.vx).toFixed(2) }));
    return JSON.stringify({ t: 's', time: +this.time.toFixed(1), started: this.started, winner: this.winner, pl, mn, st, pr, ev: this.ev });
  }

  send() {
    if (this.players.size === 0) return;
    const msg = this.snapshot();
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
    }
  }

  stop() { clearInterval(this.loop); }
}

function start() {
  const { WebSocketServer } = require('ws');
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX));
    } else {
      res.writeHead(404); res.end('404');
    }
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', ws => {
    let game = null, me = null;
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join' && !game) {
        const code = String(m.room || '').trim().toLowerCase().slice(0, 20) || 'oda';
        let g = rooms.get(code);
        if (!g) { g = new Game(code); rooms.set(code, g); }
        const p = g.addPlayer(ws, String(m.name || ''));
        if (!p) { ws.send(JSON.stringify({ t: 'err', msg: 'Oda dolu (en fazla 6 kişi).' })); return; }
        game = g; me = p;
        ws.send(JSON.stringify({ t: 'hi', id: p.id, team: p.team, w: W, h: H, lane: LANE, code }));
      } else if (game && me) {
        game.input(me, m);
      }
    });
    ws.on('close', () => {
      if (!game || !me) return;
      game.players.delete(me.id);
      if (game.players.size === 0) { game.stop(); rooms.delete(game.code); }
    });
  });

  server.listen(PORT, () => console.log('Koridor çalışıyor: http://localhost:' + PORT));
}

if (require.main === module) start();
module.exports = { Game };
