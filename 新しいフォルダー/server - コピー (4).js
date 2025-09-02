/**
 * server.js (integrated)
 * ...
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");                 // ← ここにまとめる
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const waiters = new Map(); // id -> {resolve, reject}

/* ==============================
 *  Config (adjust to your env)
 * ============================== */
const PORT = process.env.PORT || 5173;

// Edit here if your paths differ:
const KATAGO_DIR  = "C:\\tools\\katago\\katago-v1.16.3-eigen-windows-x64+bs50";
const KATAGO_EXE  = `${KATAGO_DIR}\\katago.exe`;
const MODEL_PATH  = `${KATAGO_DIR}\\weights\\kata1-b18c384nbt.bin.gz`;
const CONFIG_PATH = `${KATAGO_DIR}\\analysis.cfg`;

// ← 未使用だった古い mustExist は削除
function mustExist(p, name) {
  if (!fs.existsSync(p)) throw new Error(`${name} not found: ${p}`);
}
mustExist(KATAGO_EXE,  "KATAGO_EXE");
mustExist(MODEL_PATH,  "KATAGO_MODEL");
mustExist(CONFIG_PATH, "KATAGO_CFG");

// Sprint JSONL
const SPRINT_JSONL = path.join(__dirname, "positions_80_clean.jsonl");

/* ==============================
 *  App setup
 * ============================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

/* ==============================
 *  Sprint helpers
 * ============================== */
// --- Moves normalization: SGF -> GTP for KataGo ---
const GTP_LETTERS = "ABCDEFGHJKLMNOPQRST"; // (I) is skipped
function sgfToGtp(loc, size = 19) {
  if (!loc) return "pass";
  const s = String(loc).toLowerCase();
  if (s === "pass") return "pass";
  if (s.length !== 2) return "pass";
  const x = s.charCodeAt(0) - 97; // 'a'->0
  const y = s.charCodeAt(1) - 97;
  if (x < 0 || y < 0 || x >= size || y >= size) return "pass";
  const col = GTP_LETTERS[x];
  const row = size - y;
  return col + row;
}
function normalizeMovesToKataGo(movesAny, size = 19) {
  if (!Array.isArray(movesAny)) return [];
  const out = [];
  for (const m of movesAny) {
    let c = (m && (m.player ?? m[0])) ?? "";
    let loc = (m && (m.loc ?? m[1])) ?? "";
    c = String(c).toLowerCase();
    if (c !== "b" && c !== "w") continue;
    const gtp = sgfToGtp(loc, size);
    out.push([c, gtp]);
  }
  return out;
}

function loadSprintPositions(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.map(l => JSON.parse(l));
  } catch (e) {
    console.warn("[Sprint] positions file not found or unreadable:", jsonlPath, e.message);
    return [];
  }
}
function boardRowsToStones(entry) {
  const stones = [];
  const rows = entry.board_rows || [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "B" || ch === "W") stones.push({ color: ch, x, y });
    }
  }
  return stones;
}
// SGF 'aa' -> (r,c)
function sgfCoordToRC(s) {
  if (!s || s.length !== 2) return null;
  const r = s.charCodeAt(1) - 97;
  const c = s.charCodeAt(0) - 97;
  if (r < 0 || r >= 19 || c < 0 || c >= 19) return null;
  return { r, c };
}
function lastMoveFromEntry(entry) {
  try {
    const mv = entry.moves_80 && entry.moves_80[entry.moves_80.length - 1];
    if (!mv) return null;
    const [c, p] = mv.split(":");
    const rc = sgfCoordToRC(p);
    if (!rc) return null;
    return { color: c, x: rc.c, y: rc.r };
  } catch {
    return null;
  }
}
const SPRINTS = loadSprintPositions(SPRINT_JSONL);

/* ==============================
 *  Sprint endpoints
 * ============================== */
app.get("/api/sprint/random", (_req, res) => {
  if (!SPRINTS.length) return res.status(404).json({ ok: false, error: "no sprint data" });
  const e = SPRINTS[Math.floor(Math.random() * SPRINTS.length)];
  return res.json({
    ok: true,
    id: e.id,
    player_to_move: e.player_to_move,
    komi: (e.komi != null ? Number(e.komi) : 6.5),
    result: e.result ?? null,
    stones: boardRowsToStones(e),
    last_move: lastMoveFromEntry(e),
  });
});
app.get("/api/sprint/byId", (req, res) => {
  const id = req.query.id;
  const e = SPRINTS.find(x => x.id === id);
  if (!e) return res.status(404).json({ ok: false, error: "id not found" });
  return res.json({
    ok: true,
    id: e.id,
    player_to_move: e.player_to_move,
    komi: (e.komi != null ? Number(e.komi) : 6.5),
    result: e.result ?? null,
    stones: boardRowsToStones(e),
    last_move: lastMoveFromEntry(e),
  });
});

/* ==============================
 *  KataGo persistent engine
 * ============================== */
let kg = null;
let rl = null;
let reqCounter = 0;
const inFlight = new Map(); // id -> {resolve,reject}

function startKataGo() {
  if (kg) return;
  console.log("[KataGo] Spawning:", KATAGO_EXE);
  kg = spawn(KATAGO_EXE, ["analysis", "-model", MODEL_PATH, "-config", CONFIG_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  kg.on("error", (err) => {
    console.error("[KataGo] spawn error:", err);
  });
  kg.stderr.on("data", (d) => {
    process.stderr.write("[KataGo STDERR] " + d.toString());
  });

  // line-by-line JSON from stdout（グローバル rl / waiters を使う）
  rl = readline.createInterface({ input: kg.stdout });


rl.on("line", (line) => {
  line = line.trim();
  if (!line.startsWith("{")) return; // skip non-JSON
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj.id) return;
  // ★ 完了行だけ拾う
  if (obj.isDuringSearch === false) {
      const w = waiters.get(obj.id);
      if (w) { w.resolve(obj); waiters.delete(obj.id); }
  }
});


  kg.on("close", (code) => {
    console.warn("[KataGo] process closed:", code);

    // base と同じ流儀：待機中の約束をきちんと落とす
    for (const [id, p] of waiters.entries()) {
      p.reject(new Error("KataGo terminated"));
    }
    waiters.clear();
    // （inFlight を使わないならここは不要ですが、残すなら同様に掃除）
    for (const [id, p] of inFlight.entries()) {
      p.reject(new Error("KataGo terminated"));
    }
    inFlight.clear();


    kg = null;
    rl = null;
  });
}

function katagoRequest(payload) {
  return new Promise((resolve, reject) => {
    if (!kg) startKataGo();
    const id = "req_" + (++reqCounter);
    payload.id = id;
    inFlight.set(id, { resolve, reject });
    kg.stdin.write(JSON.stringify(payload) + "\n", "utf8");
    setTimeout(() => {
      if (inFlight.has(id)) {
        inFlight.delete(id);
        reject(new Error("KataGo timeout"));
      }
    }, Math.max(3000, Math.floor((payload.maxTime || 1.0) * 4000)));
  });
}

/* ==============================
 *  /api/analyze
 * ============================== */
app.post("/api/analyze", async (req, res) => {
  try {

    const { moves = [], rules = "japanese", komi = 6.5, maxTime } = req.body || {};

    // Normalize moves from [{player:'B',loc:'aa'}] to KataGo pairs
    const movesGtp = normalizeMovesToKataGo(moves, 19);
    const mt = Number(maxTime); // ← 数値化（NaNなら後で除外）

    const id = "req_" + Math.random().toString(36).slice(2);

    // ★ 安定版と同じ“handoff”：19×19をサーバで必ず数値注入
    const payload = {
      id,
      rules,
      komi: Number.isFinite(komi) ? komi : 6.5,
      boardXSize: 19,
      boardYSize: 19,
      moves,                     // [["B","D4"],["W","Q16"],...]
      // 必要なら includeOwnership / includePolicy をここで true/false
      ...(Number.isFinite(mt) ? { maxTime: mt } : {})
    };

    // 書く（1行JSON + 改行）→ 待つ
    const p = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    console.log("[Analyze] -> KataGo:", JSON.stringify(payload));
    kg.stdin.write(JSON.stringify(payload) + "\n");

    const result = await p; // ← “最終行だけ”が入る

    // 最小の返却（安定版同等）
    const moveInfos = result?.moveInfos || [];
    const best = moveInfos.reduce((a, b) => (a && a.order <= b.order ? a : b), moveInfos[0]);
    const bestMove = best?.move ?? null;

    res.json({ ok: true, id, bestMove, katago: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/* ==============================
 *  Root
 * ============================== */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("Server listening on http://localhost:" + PORT);
  console.log("[Sprint] positions:", SPRINTS.length);
  // 起動時に KataGo を常駐起動（安定版と同じ運用）
  startKataGo();

});
