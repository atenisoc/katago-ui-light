/**
 * server.js (multi-engine)
 * - Static hosting for index.html 等
 * - 3つの KataGo analysis エンジンを常駐 (easy/normal/hard)
 * - /api/analyze?engine=easy|normal|hard で該当エンジンにルーティング
 * - /api/comment は aiComment.js を利用（既存仕様維持）
 */

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const { spawn }= require("child_process");
const readline = require("readline");


const ENGINES = {
  easy: {
    exe: "C:\\tools\\katago\\engines\\easy_b6\\katago.exe",
    model: "C:\\tools\\katago\\engines\\easy_b6\\weights\\kata1-b6c96-s50894592-d7380655.txt.gz",
    cfg: "C:\\tools\\katago\\engines\\easy_b6\\analysis.cfg",
  },
normal: {
  exe: "C:\\tools\\katago\\engines\\normal_b10\\katago.exe",
  model: "C:\\tools\\katago\\engines\\normal_b10\\weights\\kata1-b6c96-s175395328-d26788732.txt.gz", // ← これに変更
  cfg: "C:\\tools\\katago\\engines\\normal_b10\\analysis.cfg",
},
  hard: { // ← 優劣（/api/eval）は常にコレを使う
    exe: "C:\\tools\\katago\\engines\\hard_b18\\katago.exe",
    model: "C:\\tools\\katago\\engines\\hard_b18\\weights\\kata1-b10c128-s1141046784-d204142634.txt.gz", // ★直参照
    cfg: "C:\\tools\\katago\\engines\\hard_b18\\analysis.cfg",
  },
};





const PORT = process.env.PORT || 5173;

// ====== 便利関数 ======
function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}

function sanitizeEngineName(name) {
  const n = (name || "").toLowerCase();
  return n === "easy" || n === "hard" ? n : "normal";
}

// ====== Express 準備 ======
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// UI（index.html など）を同ディレクトリから配信
app.use(express.static(path.join(__dirname)));

// ==== 中盤スプリント: positions_80_clean.jsonl を読む ====
const POSITIONS_PATH = (() => {
  // 1) カレント
  const p1 = path.join(__dirname, "positions_80_clean.jsonl");
  if (fs.existsSync(p1)) return p1;
  // 2) 以前の既定パス
  const p2 = "C:\\tools\\katago\\katago-ui\\positions_80_clean.jsonl";
  if (fs.existsSync(p2)) return p2;
  // 3) Docker/WSL等の共有
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
        if (line) {
          count++;
          if (Math.random() < 1 / count) chosen = line; // reservoir sampling
        }
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

// JSONL → moves 変換（複数フォーマット対応）
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
      // 既に [["B","K10"], ...] 形式
      moves = rec.moves;
    } else if (Array.isArray(rec?.moves_80)) {
      // 例: "b:dd" の配列
      for (const item of rec.moves_80) {
        const [bwRaw, c2] = String(item).split(":");
        const mv = sgfToMove(c2);
        if (mv) moves.push([bwRaw.toUpperCase(), mv]);
      }
    } else if (Array.isArray(rec?.board_rows)) {
      // 盤面スナップショットから再構成
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
      id: rec.id ?? null,
      player_to_move: rec.player_to_move ?? null,
      komi: rec.komi ?? null,
      size: N
    };
    return res.json({ ok:true, recId: rec.id ?? null, meta, moves });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message ?? e) });
  }
});



// ====== KataGo 複数常駐 ======
/**
 * procs[name] = {
 *   proc: ChildProcess,
 *   rl:   Readline.Interface,
 *   waiters: Map<id, {resolve, reject}>
 * }
 */
const procs = {};
const engineMeta = {}; // runtime-captured info per engine (modelName/backend/version)

function spawnEngine(name) {
  const { exe, model, cfg } = ENGINES[name];

  // 事前チェック（存在しないと落ちるのでエラーメッセージを早めに）
  mustExist(exe,   `[${name}] katago.exe`);
  mustExist(model, `[${name}] model`);
  mustExist(cfg,   `[${name}] analysis.cfg`);

  const args = ["analysis", "-model", model, "-config", cfg];
  const proc = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
const rlErr = readline.createInterface({ input: proc.stderr });
rlErr.on('line', (line) => {
  const msg = line.toString();
  console.error(`[${name}] ${msg}`);
  try {
    let m;
    m = msg.match(/backend\s*(.*)thread/i);
    if (m) {
      engineMeta[name] = engineMeta[name] || {};
      engineMeta[name].backend = m[1].trim();
    }
    m = msg.match(/Model name:\s*([\w\-\.]+)\s*$/i);
    if (m) {
      engineMeta[name] = engineMeta[name] || {};
      engineMeta[name].modelName = m[1];
    }
    m = msg.match(/Model version\s*(\d+)/i);
    if (m) {
      engineMeta[name] = engineMeta[name] || {};
      engineMeta[name].version = parseInt(m[1],10);
    }
  } catch {}
});


  const rl = readline.createInterface({ input: proc.stdout });
  const waiters = new Map();

  rl.on("line", (line) => {
    // KataGo analysis は 1行に1 JSON で返してくる
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // JSON 以外の行は無視（進捗や空行など）
      return;
    }
    const id = msg && msg.id;
    if (id && waiters.has(id)) {
      const { resolve } = waiters.get(id);
      waiters.delete(id);
      resolve(msg);
    }
  });

  proc.stderr.on("data", (d) => {
    const s = d.toString();
    console.error(`[${name}]`, s.trim());
  });

  proc.on("exit", (code, signal) => {
    console.error(`[${name}] exited: code=${code} signal=${signal}`);
    // 落ちたら自動再起動（必要なければ削除）
    setTimeout(() => {
      try {
        spawnEngine(name);
      } catch (e) {
        console.error(`[${name}] respawn failed:`, e);
      }
    }, 1500);
  });

  procs[name] = { proc, rl, waiters };
  console.log(`[spawned] ${name} -> ${exe}`);
}

/**
 * 指定エンジンに 1 リクエスト送る
 * payload は {moves, rules, komi, maxVisits, ...} など
 */
function askKatago(name, payload) {
  return new Promise((resolve, reject) => {
    const eng = procs[name];
    if (!eng || !eng.proc || eng.proc.killed) {
      return reject(new Error(`engine "${name}" is not running`));
    }
    const id = `req_${Math.random().toString(36).slice(2)}`;
    const body = { ...payload, id };

    eng.waiters.set(id, { resolve, reject });

    try {
      eng.proc.stdin.write(JSON.stringify(body) + "\n");
    } catch (e) {
      eng.waiters.delete(id);
      reject(e);
    }

    // タイムアウト（保険）
    setTimeout(() => {
      if (eng.waiters.has(id)) {
        eng.waiters.delete(id);
        reject(new Error(`engine "${name}" timeout for id=${id}`));
      }
    }, 30_000);
  });
}

// 3エンジン起動
["easy", "normal", "hard"].forEach(spawnEngine);


// ====== API: 優劣の直接評価（循環なし・hard直参照） ======
/**
 * POST /api/eval
 * body: { moves, rules?, komi?, maxVisits? }
 * return: { ok, engine, model, modelName, winrateBlack, scoreLead, pv, katago }
 */
app.post("/api/eval", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.rules) payload.rules = "japanese";
    if (typeof payload.komi !== "number") payload.komi = 6.5;
    if (typeof payload.maxVisits !== "number") payload.maxVisits = 128; // ここで評価の強さを決める
    payload.includeOwnership = false;

    // ← 循環なし：hard へ 1 回だけ直投げ
    const out = await askKatago("hard", payload);

    // 要約（UIはこれを表示。生 out も返す）
    const root = out?.rootInfo || {};
    const top  = (out?.moveInfos || [])[0] || {};
    return res.json({
      ok: true,
      engine: "hard",
      model: ENGINES.hard.model,                           // ★ 直参照しているパスをそのまま返す
      modelName: (engineMeta?.hard?.modelName) || null,    // 起動ログから拾えたモデル名（例: b10c128-...）
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





// ====== API: コメント生成（既存の aiComment.js を使用） ======
/**
 * POST /api/comment
 * body: { skeleton: {...}, banPhrases:[], lengthHint:[] }
 * return: { text }
 */
let aiComment = null;
try {
  aiComment = require("./aiComment");
} catch (e) {
  console.warn("aiComment.js not found or failed to load. /api/comment will return a fallback.");
}

app.post("/api/comment", async (req, res) => {
  try {
    if (!aiComment || typeof aiComment.generateComment !== "function") {
      return res.json({ text: "（コメント機能は現在オフラインです）" });
    }
    const { skeleton, banPhrases, lengthHint } = req.body || {};
    const text = await aiComment.generateComment({ skeleton, banPhrases, lengthHint });
    return res.json({ text });
  } catch (e) {
    console.error("[/api/comment] error:", e);
    return res.status(500).json({ error: "openai_failed", detail: String(e && e.message ? e.message : e) });
  }
});

// ====== サーバ起動 ======
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ====== 終了処理（Ctrl+C 等） ======
function shutdown() {
  console.log("Shutting down engines...");
  for (const name of Object.keys(procs)) {
    try {
      procs[name].proc.kill();
    } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
