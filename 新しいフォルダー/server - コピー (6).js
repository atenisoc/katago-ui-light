// server.js - Minimal KataGo analysis bridge + static UI
// Edit here if your paths differ:
const KATAGO_DIR   = "C:\\tools\\katago\\katago-v1.16.3-eigen-windows-x64+bs50";
const KATAGO_EXE   = `${KATAGO_DIR}\\katago.exe`;
const MODEL_PATH   = `${KATAGO_DIR}\\kata1-b18c384nbt.bin.gz`;
const CONFIG_PATH  = `${KATAGO_DIR}\\analysis.cfg`;   // maxTime = 5 を推奨

const PORT = 5173;

const express = require("express");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const app = express();
app.use(express.json());

// ---- spawn persistent katago (analysis) ----
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
kg.stderr.on("data", (d) => {
  // show warnings/errors in server console (参考)
  process.stdout.write(d);
});

// line-by-line JSON from stdout
const rl = readline.createInterface({ input: kg.stdout });
const waiters = new Map(); // id -> {resolve,reject}

rl.on("line", (line) => {
  line = line.trim();
  if (!line.startsWith("{")) return; // skip non-JSON
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj.id) return;
  // 完了行（isDuringSearch=false）を拾って返す
  if (obj.isDuringSearch === false) {
    const w = waiters.get(obj.id);
    if (w) { w.resolve(obj); waiters.delete(obj.id); }
  }
});

process.on("exit", () => { try { kg.kill(); } catch {} });
process.on("SIGINT", () => { try { kg.kill(); } catch {}; process.exit(0); });

// ---- tiny helper ----
function bestMoveFromMoveInfos(moveInfos) {
  if (!Array.isArray(moveInfos) || moveInfos.length === 0) return null;
  // visits降順でソートして先頭を採用
  const sorted = [...moveInfos].sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0));
  return sorted[0].move || null;
}

// ---- API: analyze (返答に最善手も付ける) ----
app.post("/api/analyze", async (req, res) => {
  try {
    const { moves, maxTime, maxVisits, komi, rules } = req.body || {};
    const id = "req_" + Math.random().toString(36).slice(2);

    const payload = {
      id,
      rules: rules ?? "japanese",
      komi: typeof komi === "number" ? komi : 6.5,
      boardXSize: 19,
      boardYSize: 19,
      moves: Array.isArray(moves) ? moves : [],
    };
    if (typeof maxTime === "number") payload.maxTime = maxTime;
    if (typeof maxVisits === "number") payload.maxVisits = maxVisits;

    // 1リクエスト待ち
    const p = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    kg.stdin.write(JSON.stringify(payload) + "\n");
    const result = await p;

    const mv = bestMoveFromMoveInfos(result.moveInfos);
    res.json({ ok: true, id, bestMove: mv, katago: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- static UI ----
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`UI: http://localhost:${PORT}`);
  console.log("POST /api/analyze  { moves:[['B','K10'],...], maxTime:5 }");
});
