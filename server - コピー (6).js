/**
 * server.js (multi-engine, integrated for katago3)
 * - Static hosting for index.html
 * - 3 KataGo engines (easy / normal / hard)
 * - /api/analyze?engine=easy|normal|hard : 対局用分析
 * - /api/eval : hardで評価（勝率/点差/PV）
 * - /api/sprint/random : 中盤ランダム初期局面
 * - /api/comment : aiComment.js があれば利用
 */

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const { spawn }= require("child_process");
const readline = require("readline");

// ====== env 読み込み（任意） ======
require('dotenv').config({ path: '.env.local' });

// ====== エンジン定義（環境変数 > 既定: C:\tools\katago3\...） ======
const ENGINES = {
  easy: {
    exe:   process.env.KATAGO_EASY_EXE   || "C:\\\\tools\\\\katago3\\\\engines\\\\easy_b6\\\\katago.exe",
    model: process.env.KATAGO_EASY_MODEL || "C:\\\\tools\\\\katago3\\\\engines\\\\easy_b6\\\\weights\\\\kata1-b6c96-s50894592-d7380655.txt.gz",
    cfg:   process.env.KATAGO_EASY_CFG   || "C:\\\\tools\\\\katago3\\\\engines\\\\easy_b6\\\\analysis.cfg",
  },
  normal: {
    exe:   process.env.KATAGO_NORMAL_EXE   || "C:\\\\tools\\\\katago3\\\\engines\\\\normal_b10\\\\katago.exe",
    model: process.env.KATAGO_NORMAL_MODEL || "C:\\\\tools\\\\katago3\\\\engines\\\\normal_b10\\\\weights\\\\kata1-b10c128-s1141046784-d204142634.txt.gz",
    cfg:   process.env.KATAGO_NORMAL_CFG   || "C:\\\\tools\\\\katago3\\\\engines\\\\normal_b10\\\\analysis.cfg",
  },
  hard: {
    exe:   process.env.KATAGO_HARD_EXE   || "C:\\\\tools\\\\katago3\\\\engines\\\\hard_b18\\\\katago.exe",
    model: process.env.KATAGO_HARD_MODEL || "C:\\\\tools\\\\katago3\\\\engines\\\\hard_b18\\\\weights\\\\kata1-b10c128-s1141046784-d204142634.txt.gz",
    cfg:   process.env.KATAGO_HARD_CFG   || "C:\\\\tools\\\\katago3\\\\engines\\\\hard_b18\\\\analysis.cfg",
  },
};

const PORT = process.env.PORT || 5173;

// ====== ユーティリティ ======
function mustExist(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}
function sanitizeEngineName(name) {
  const n = String(name || "").toLowerCase();
  return (n === "easy" || n === "normal" || n === "hard") ? n : "normal";
}

// ====== Express 準備 ======
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// UI（index.html 等）を同ディレクトリから配信
app.use(express.static(path.join(__dirname)));

app.get('/healthz', (_req, res) => res.status(204).end());

// ==== positions_80_clean.jsonl の場所探し ====
const POSITIONS_PATH = (() => {
  const p1 = path.join(__dirname, "positions_80_clean.jsonl");
  if (fs.existsSync(p1)) return p1;
  const p2 = "C:\\\\tools\\\\katago3\\\\katago-ui\\\\positions_80_clean.jsonl";
  if (fs.existsSync(p2)) return p2;
  const p3 = "/mnt/data/positions_80_clean.jsonl";
  return p3;
})();

function pickRandomJsonlLine(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error(`JSONL not found: ${filePath}`));
    const rs = fs.createReadStream(filePath, { encoding: "utf8" });
    let chosen = null, count = 0, buf = "";
    rs.on("data", chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) { count++; if (Math.random() < 1 / count) chosen = line; }
      }
    });
    rs.on("end", () => {
      if (!chosen) return reject(new Error("No valid lines in JSONL"));
      try { resolve(JSON.parse(chosen)); }
      catch { reject(new Error("Invalid JSON in chosen line")); }
    });
    rs.on("error", reject);
  });
}

// JSONL → moves 変換（/api/sprint/random）
app.get("/api/sprint/random", async (_req, res) => {
  try {
    const rec = await pickRandomJsonlLine(POSITIONS_PATH);
    const N = rec?.size || 19;
    const letters = "ABCDEFGHJKLMNOPQRST";
    const sgfToMove = (c2) => {
      if (typeof c2 !== "string" || c2.length < 2) return null;
      const x = c2.charCodeAt(0) - 97, y = c2.charCodeAt(1) - 97;
      if (x < 0 || y < 0 || x >= N || y >= N) return null;
      return letters[x] + String(N - y);
    };
    let moves = [];
    if (Array.isArray(rec?.moves)) {
      moves = rec.moves; // [["B","K10"], ...]
    } else if (Array.isArray(rec?.moves_80)) {
      for (const item of rec.moves_80) {
        const [bwRaw, c2] = String(item).split(":");
        const mv = sgfToMove(c2);
        if (mv) moves.push([bwRaw.toUpperCase(), mv]);
      }
    } else if (Array.isArray(rec?.board_rows)) {
      for (let y = 0; y < N; y++) {
        const row = rec.board_rows[y] || "";
        for (let x = 0; x < N; x++) {
          const ch = row[x];
          if (ch === "B" || ch === "W") {
            moves.push([ch, letters[x] + String(N - y)]);
          }
        }
      }
    } else {
      return res.status(400).json({ ok:false, error:"Record has no supported fields." });
    }
    const meta = {
      id: rec.id ?? null, player_to_move: rec.player_to_move ?? null,
      komi: rec.komi ?? null, size: N
    };
    return res.json({ ok:true, recId: rec.id ?? null, meta, moves });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message ?? e) });
  }
});

// ====== KataGo プロセス管理 ======
/**
 * procs[name] = { proc, rl, waiters }
 */
const procs = {};
const engineMeta = {}; // モデル名/バックエンド/バージョン/katago など

function spawnEngine(name) {
  const { exe, model, cfg } = ENGINES[name];
  mustExist(exe,   `[${name}] katago.exe`);
  mustExist(model, `[${name}] model`);
  mustExist(cfg,   `[${name}] analysis.cfg`);

  const args = ["analysis", "-model", model, "-config", cfg];
  const proc = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  // stderr（バックエンド/モデル名など抽出）
  const rlErr = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
  rlErr.on('line', (line) => {
    const msg = String(line).trim();
    if (!msg) return;
    console.error(`[${name}] ${msg}`);
    try {
      let m;
      m = msg.match(/backend\s*(.*)thread/i);
      if (m) { engineMeta[name] = engineMeta[name] || {}; engineMeta[name].backend = m[1].trim(); }
      m = msg.match(/Model name:\s*([\w\-\.]+)\s*$/i);
      if (m) { engineMeta[name] = engineMeta[name] || {}; engineMeta[name].modelName = m[1]; }
      m = msg.match(/Model version\s*(\d+)/i);
      if (m) { engineMeta[name] = engineMeta[name] || {}; engineMeta[name].version = parseInt(m[1], 10); }
      m = msg.match(/KataGo v(\d+\.\d+\.\d+)/i);
      if (m) { engineMeta[name] = engineMeta[name] || {}; engineMeta[name].katago = m[1]; }
    } catch {}
  });
  proc.on("exit", () => { try { rlErr.close(); } catch {} });

  // stdout（1行=1JSON）
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const waiters = new Map();
  rl.on("line", (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }
    const id = msg && msg.id;
    if (id && waiters.has(id)) {
      const { resolve } = waiters.get(id);
      waiters.delete(id);
      resolve(msg);
    }
  });

  proc.on("exit", (code, signal) => {
    console.error(`[${name}] exited: code=${code} signal=${signal}`);
    setTimeout(() => {
      try { spawnEngine(name); } catch (e) { console.error(`[${name}] respawn failed:`, e); }
    }, 1500);
  });

  procs[name] = { proc, rl, waiters };
  console.log(`[spawned] ${name} -> ${exe}`);
}

/** 指定エンジンに1リクエスト送る */
function askKatago(name, payload) {
  return new Promise((resolve, reject) => {
    const eng = procs[name];
    if (!eng || !eng.proc || eng.proc.killed) return reject(new Error(`engine "${name}" is not running`));
    const id = `req_${Math.random().toString(36).slice(2)}`;
    const body = { ...payload, id };
    eng.waiters.set(id, { resolve, reject });
    try { eng.proc.stdin.write(JSON.stringify(body) + "\n"); }
    catch (e) { eng.waiters.delete(id); return reject(e); }
    setTimeout(() => {
      if (eng.waiters.has(id)) { eng.waiters.delete(id); reject(new Error(`engine "${name}" timeout for id=${id}`)); }
    }, 30_000);
  });
}

// 起動時に3エンジンを起動
["easy", "normal", "hard"].forEach(spawnEngine);

// ====== API: hard でのクイック評価（/api/eval） ======
app.post("/api/eval", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.rules) payload.rules = "japanese";
    if (typeof payload.komi !== "number") payload.komi = 6.5;
    if (typeof payload.maxVisits !== "number") payload.maxVisits = 128;
    payload.includeOwnership = false;

    const out = await askKatago("hard", payload);
    const root = out?.rootInfo || {};
    const top  = (out?.moveInfos || [])[0] || {};
    return res.json({
      ok: true,
      engine: "hard",
      model: ENGINES.hard.model,
      modelName: (engineMeta?.hard?.modelName) || null,
      winrateBlack: (typeof root.winrate === "number") ? root.winrate : null,
      scoreLead: (typeof root.scoreLead === "number") ? root.scoreLead : null,
      pv: Array.isArray(top.pv) ? top.pv : [],
      katago: out
    });
  } catch (e) {
    console.error("[/api/eval] error:", e);
    return res.status(500).json({ ok:false, error: String(e?.message ?? e) });
  }
});

// ====== API: コメント生成（/api/comment） ======
let aiComment = null;
try { aiComment = require("./aiComment"); }
catch { console.warn("aiComment.js not found or failed to load. /api/comment will return a fallback."); }

app.post("/api/comment", async (req, res) => {
  try {
    if (!aiComment || typeof aiComment.generateComment !== "function") {
      return res.json({ text: "コメント生成は現在の設定では無効です（aiComment.js未導入）。" });
    }
    const { skeleton, banPhrases, lengthHint } = req.body || {};
    const text = await aiComment.generateComment({ skeleton, banPhrases, lengthHint });
    return res.json({ text });
  } catch (e) {
    console.error("[/api/comment] error:", e);
    return res.status(500).json({ error: "openai_failed", detail: String(e && e.message ? e.message : e) });
  }
});

// ====== API: 対局用分析（/api/analyze?engine=...） ======
app.post("/api/analyze", async (req, res) => {
  try {
    const engine = sanitizeEngineName(req.query.engine || "normal");
    const payload = req.body || {};
    if (!payload.rules) payload.rules = "japanese";
    if (typeof payload.komi !== "number") payload.komi = 6.5;

    const katagoResp = await askKatago(engine, payload);

    // visits 最大手を bestMove とする
    let bestMove = null;
    if (katagoResp && Array.isArray(katagoResp.moveInfos) && katagoResp.moveInfos.length) {
      const sorted = [...katagoResp.moveInfos].sort((a, b) => (b.visits || 0) - (a.visits || 0));
      bestMove = (sorted[0] && sorted[0].move) || null;
    }
    return res.json({ ok: true, bestMove, katago: katagoResp });
  } catch (e) {
    console.error("[/api/analyze] error:", e);
    return res.status(500).json({ ok:false, error: String(e && e.message ? e.message : e) });
  }
});

// ====== サーバ起動 ======
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ====== 終了処理 ======
function shutdown() {
  console.log("Shutting down engines...");
  for (const name of Object.keys(procs)) {
    try { procs[name].proc.kill(); } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
