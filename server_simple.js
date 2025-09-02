// server_simple.js - Minimal KataGo analysis bridge (stable)
// Based on your stable reference. Adds ONLY one safeguard: lowercase 'b'/'w' before sending.
// Paths: adjust if needed.
// server_simple.js 冒頭
const KATAGO_DIR  = "C:\\tools\\katago\\katago-v1.16.3-eigen-windows-x64+bs50";
const KATAGO_EXE  = `${KATAGO_DIR}\\katago.exe`;
const MODEL_PATH  = `${KATAGO_DIR}\\weights\\kata1-b18c384nbt.bin.gz`;  // ← ここ修正
const CONFIG_PATH = `${KATAGO_DIR}\\analysis.cfg`;


const PORT = 5173;

const express = require("express");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const app = express();
app.use(express.json());

// --- Start persistent KataGo (analysis) ---
console.log("[KataGo] spawning analysis engine...");
const kg = spawn(KATAGO_EXE, ["analysis", "-model", MODEL_PATH, "-config", CONFIG_PATH], {
  cwd: KATAGO_DIR,
  stdio: ["pipe", "pipe", "pipe"],
});

kg.on("error", (e) => {
  console.error("Failed to start KataGo:", e);
  process.exit(1);
});

kg.stderr.setEncoding("utf8");
kg.stderr.on("data", (d) => process.stdout.write(d));

// --- Waiter map for per-request responses ---
const rl = readline.createInterface({ input: kg.stdout });
const waiters = new Map(); // id -> {resolve,reject}

rl.on("line", (line) => {
  line = line.trim();
  if (!line.startsWith("{")) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj.id) return;
  if (obj.isDuringSearch === false) {
    const w = waiters.get(obj.id);
    if (w) { w.resolve(obj); waiters.delete(obj.id); }
  }
});

process.on("exit", () => { try { kg.kill(); } catch {} });
process.on("SIGINT", () => { try { kg.kill(); } catch {}; process.exit(0); });

// --- Helpers ---
function bestMoveFromMoveInfos(moveInfos) {
  if (!Array.isArray(moveInfos) || moveInfos.length === 0) return null;
  // pick by visits desc
  const sorted = [...moveInfos].sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0));
  return sorted[0]?.move || null;
}

function normalizeMovesBW(moves) {
  if (!Array.isArray(moves)) return [];
  return moves
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(([c, v]) => [String(c).toLowerCase(), String(v)]);
}

// --- API: analyze ---
app.post("/api/analyze", async (req, res) => {
  try {
    const { moves, maxTime, komi, rules } = req.body || {};
    const id = "req_" + Math.random().toString(36).slice(2);

    const payload = {
      id,
      rules: rules ?? "japanese",
      komi: typeof komi === "number" ? komi : 6.5,
      boardXSize: 19,
      boardYSize: 19,
      moves: normalizeMovesBW(moves), // << ONLY safeguard added
    };
    if (typeof maxTime === "number") payload.maxTime = maxTime;

    const p = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    kg.stdin.write(JSON.stringify(payload) + "\\n");

    const result = await p;
    const mv = bestMoveFromMoveInfos(result.moveInfos);
    res.json({ ok: true, id, bestMove: mv, katago: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Static UI ---
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index_simple.html")));

app.listen(PORT, () => {
  console.log(`UI: http://localhost:${PORT}`);
  console.log("POST /api/analyze  { moves:[['B','K10'],...], maxTime:5 }");
});
