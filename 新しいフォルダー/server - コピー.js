// server.js (ver2) - Minimal KataGo analysis bridge + "start-from-middle"
// 動かし方は前回と同じ: `npm i express` -> `node server.js` -> http://localhost:5173

// === あなたの環境に合わせたパス設定 ===
const KATAGO_DIR   = "C:\\tools\\katago\\katago-v1.16.3-eigen-windows-x64+bs50";
const KATAGO_EXE   = `${KATAGO_DIR}\\katago.exe`;
const MODEL_PATH   = `${KATAGO_DIR}\\kata1-b18c384nbt.bin.gz`;   // 実ファイル名と一致しているか確認
const CONFIG_PATH  = `${KATAGO_DIR}\\analysis.cfg`;              // maxTime はここ or リクエストで上書き

const PORT = 5173;

const express = require("express");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const app = express();
app.use(express.json());

// ---- KataGo 常駐起動 ----
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
  process.stdout.write(d); // ログはサーバコンソールに
});

// stdout を1行ずつ JSON として受ける
const rl = readline.createInterface({ input: kg.stdout });
const waiters = new Map(); // id -> {resolve,reject}

rl.on("line", (line) => {
  const s = line.trim();
  if (!s.startsWith("{")) return;
  let obj;
  try { obj = JSON.parse(s); } catch { return; }
  if (!obj.id) return;
  // 完了行
  if (obj.isDuringSearch === false) {
    const w = waiters.get(obj.id);
    if (w) { w.resolve(obj); waiters.delete(obj.id); }
  }
});

process.on("exit", () => { try { kg.kill(); } catch {} });
process.on("SIGINT", () => { try { kg.kill(); } catch {}; process.exit(0); });

// ---- ヘルパ群 ----
function pickBestMove(moveInfos) {
  if (!Array.isArray(moveInfos) || moveInfos.length === 0) return null;
  const score = (m) => [
    (m.visits ?? 0),
    (m.winrate ?? 0),
    (m.prior ?? 0),
  ];
  const sorted = [...moveInfos].sort((a,b) => {
    const sa = score(a), sb = score(b);
    if (sb[0] !== sa[0]) return sb[0]-sa[0];
    if (sb[1] !== sa[1]) return sb[1]-sa[1];
    return sb[2]-sa[2];
  });
  return sorted[0].move || null;
}

function pickBestNonPass(moveInfos) {
  if (!Array.isArray(moveInfos)) return null;
  for (const m of [...moveInfos].sort((a,b)=>(b.visits??0)-(a.visits??0))) {
    const mv = m.move;
    if (!mv) continue;
    const lower = String(mv).toLowerCase();
    if (lower === "pass" || lower === "resign") continue;
    return mv;
  }
  return pickBestMove(moveInfos);
}

function sideForPly(ply0, seedLen) {
  // seedLen が偶数なら次は黒(B)、奇数なら白(W)
  const p = ply0 + seedLen;
  return (p % 2 === 0) ? "B" : "W";
}

function sendToKataGo(payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = payload.id || ("req_" + Math.random().toString(36).slice(2));
    payload.id = id;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`KataGo timeout (${timeoutMs}ms): ${id}`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (obj) => { clearTimeout(timer); resolve(obj); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
    kg.stdin.write(JSON.stringify(payload) + "\n");
  });
}

// ---- API: 1手だけの通常解析（既存） ----
app.post("/api/analyze", async (req, res) => {
  try {
    const { moves, maxTime, maxVisits, komi, rules } = req.body || {};
    const payload = {
      id: "one_" + Math.random().toString(36).slice(2),
      rules: rules ?? "japanese",
      komi: typeof komi === "number" ? komi : 6.5,
      boardXSize: 19,
      boardYSize: 19,
      moves: Array.isArray(moves) ? moves : [],
    };
    if (typeof maxTime === "number")  payload.maxTime  = maxTime;
    if (typeof maxVisits === "number") payload.maxVisits = maxVisits;

    const result = await sendToKataGo(payload);
    const mv = pickBestMove(result.moveInfos);
    res.json({ ok: true, bestMove: mv, katago: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- API: まとめて生成（中盤スタート用） ----
// 入力: { totalPly?:30, perMoveMaxTime?:0.2, perMoveMaxVisits?:5, komi?:6.5, rules?:"japanese", seedMoves?:[...] }
// 出力: { ok:true, startMoves:[...], generated: n, last: katagoObj }
app.post("/api/start-from-middle", async (req, res) => {
  try {
    const {
      totalPly = 30,                   // 生成する着手数（黒白合わせて）
      perMoveMaxTime,                  // 1手のtime上限 (秒) 例: 0.2
      perMoveMaxVisits = 5,            // または visits 上限（timeと併用しない想定）
      komi = 6.5,
      rules = "japanese",
      seedMoves = [],                  // 事前に決めた布石などがある場合はここへ
      forbidPass = true,               // 生成中はPASS/RESIGNを避ける
    } = req.body || {};

    if (!Number.isInteger(totalPly) || totalPly <= 0 || totalPly > 200) {
      return res.status(400).json({ ok:false, error:"totalPly must be 1..200" });
    }

    let moves = Array.isArray(seedMoves) ? [...seedMoves] : [];
    let lastResult = null;

    for (let i = 0; i < totalPly; i++) {
      const color = (moves.length % 2 === 0) ? "B" : "W"; // ← ここを固定ロジックに
      const payload = {
        id: "mid_" + i + "_" + Math.random().toString(36).slice(2),
        rules, komi,
        boardXSize: 19, boardYSize: 19,
        moves,
      };

      if (typeof perMoveMaxTime === "number") payload.maxTime = perMoveMaxTime;
      else payload.maxVisits = perMoveMaxVisits;

      // 解析して最善手を取得（PASS/RESIGNは可能なら回避）
      lastResult = await sendToKataGo(payload, 15000);
      let mv = forbidPass ? pickBestNonPass(lastResult.moveInfos) : pickBestMove(lastResult.moveInfos);
      if (!mv) break;
      

      // 盤外などの想定外は一旦そのまま採用（最小実装）
      moves.push([color, mv]);
    }

    res.json({
      ok: true,
      startMoves: moves,
      generated: moves.length - (Array.isArray(seedMoves) ? seedMoves.length : 0),
      last: lastResult,
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ---- 静的UI（前回の index.html をそのまま利用可能） ----
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`UI: http://localhost:${PORT}`);
  console.log("POST /api/analyze  { moves:[['B','K10'],...], maxTime:5 }");
  console.log("POST /api/start-from-middle  { totalPly:30, perMoveMaxTime:0.2 }");
});
