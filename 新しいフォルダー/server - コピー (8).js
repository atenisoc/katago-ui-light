const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const OpenAI = require("openai");

// 黒勝率の解釈: 'BLACK' | 'WHITE' | 'PLAYER_TO_MOVE'
const REPORT_AS = 'BLACK';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 5173;

// KataGo 設定
const KATAGO_DIR  = "C:\\tools\\katago\\katago-v1.16.3-eigen-windows-x64+bs50";
const KATAGO_EXE  = `${KATAGO_DIR}\\katago.exe`;
const MODEL_PATH  = `${KATAGO_DIR}\\kata1-b18c384nbt.bin.gz`;
const CONFIG_PATH = `${KATAGO_DIR}\\analysis.cfg`;

// --- KataGo プロセス起動 ---
const katago = spawn(KATAGO_EXE, ["analysis", "-model", MODEL_PATH, "-config", CONFIG_PATH]);
katago.stdout.setEncoding("utf8");
katago.stderr.setEncoding("utf8");

const rl = readline.createInterface({ input: katago.stdout });
const waiters = new Map();

rl.on("line", line => {
  try {
    const msg = JSON.parse(line);
    const waiter = waiters.get(msg.id);
    if (waiter) {
      waiters.delete(msg.id);
      waiter.resolve(msg);
    }
  } catch {}
});

katago.stderr.on("data", data => {
  console.error("[KataGo STDERR]", data.toString());
});

function askKatago(payload) {
  return new Promise((resolve, reject) => {
    const id = `req_${Math.random().toString(36).slice(2)}`;
    payload.id = id;
    waiters.set(id, { resolve, reject });
    katago.stdin.write(JSON.stringify(payload) + "\n");
  });
}

// --- ランダム初期盤面 JSONL ---
const POSITIONS_PATH = (() => {
  const p1 = path.join(__dirname, "positions_80_clean.jsonl");
  if (fs.existsSync(p1)) return p1;
  const p2 = "C:\\tools\\katago\\katago-ui\\positions_80_clean.jsonl";
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
        if (line) {
          count++;
          if (Math.random() < 1 / count) chosen = line;
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

// --- /api/sprint/random ---
app.get("/api/sprint/random", async (_req, res) => {
  try {
    const rec = await pickRandomJsonlLine(POSITIONS_PATH);
    const N = rec?.size || 19;
    const letters = "ABCDEFGHJKLMNOPQRST";

    function sgfToMove(coord2) {
      if (typeof coord2 !== "string" || coord2.length < 2) return null;
      const x = coord2.charCodeAt(0) - 97;
      const y = coord2.charCodeAt(1) - 97;
      if (x < 0 || y < 0 || x >= N || y >= N) return null;
      const col = letters[x];
      const row = N - y;
      return col + String(row);
    }

    let moves = [];

    if (Array.isArray(rec?.moves)) {
      moves = rec.moves;
    } else if (Array.isArray(rec?.moves_80)) {
      for (const item of rec.moves_80) {
        const [bwRaw, c2] = item.split(":");
        const mv = sgfToMove(c2);
        if (mv) moves.push([bwRaw.toUpperCase(), mv]);
      }
    } else if (Array.isArray(rec?.board_rows)) {
      for (let y = 0; y < N; y++) {
        const row = rec.board_rows[y] || "";
        for (let x = 0; x < N; x++) {
          const ch = row[x];
          if (ch === "B" || ch === "W") {
            const col = letters[x];
            const rowNum = N - y;
            moves.push([ch, col + String(rowNum)]);
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

// --- /api/analyze ---
app.post("/api/analyze", async (req, res) => {
  try {
    const body = req.body;
    const katagoResp = await askKatago(body);
    const bestMove = katagoResp?.moveInfos?.[0]?.move ?? null;
    return res.json({ ok: true, id: body.id, bestMove, katago: katagoResp });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});


// --- /api/comment (OpenAI必須) ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      project: process.env.OPENAI_PROJECT,   // ← 追加
    })
  : null;


function ngrams(s, n = 3) {
  const t = (s || "").replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
}
function jaccard(a, b) {
  const A = ngrams(a), B = ngrams(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}
function pickLeastSimilar(cands, history) {
  if (!history?.length) return cands[0];
  let best = cands[0], score = Infinity;
  for (const s of cands) {
    const sim = Math.max(...history.map(h => jaccard(s, h)));
    if (sim < score) { best = s; score = sim; }
  }
  return best;
}

const SYSTEM_PROMPT = [
  "あなたは落ち着いた女性対戦AIの声。ストイックで簡潔、実務家の文体。",
  "禁止: 記号(●等), 座標, 驚嘆記号, 同語の反復, クリシェ。",
  "女性語尾(〜わ/〜ね)の乱用は避ける。出力は日本語で一文のみ。",
  "語彙・語順・語尾は毎回少し変えること。"
].join(" ");

function makeUserPrompt(skeleton, banPhrases, lo, hi) {
  return `骨組み(JSON):
${JSON.stringify(skeleton ?? {}, null, 2)}

禁止表現(避ける):
${JSON.stringify(banPhrases ?? [], null, 2)}

条件:
- 一文のみ。${lo}〜${hi}字目安、±10字の揺らぎ可。
- 座標や記号は出さない。驚嘆記号禁止。
- 同じ意味でも語彙・語順を換える。比喩は控えめ。
- 女性らしさは控えめ、断定調中心。ストイック。
- 囲碁の方針や“感触”を含める（均衡, 収束, 厚み, 一本化, 霧 等）。`;
}

app.post("/api/comment", async (req, res) => {
  try {
    if (!openai) return res.status(503).json({ error: "OPENAI_API_KEY missing" });
    const { skeleton, banPhrases = [], lengthHint = [60,110] } = req.body || {};
    const [lo, hi] = Array.isArray(lengthHint) ? lengthHint : [60,110];

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: makeUserPrompt(skeleton, banPhrases, lo, hi) }
    ];

    console.log("[/api/comment] skeleton:", JSON.stringify(skeleton));
    console.log("[/api/comment] sending messages:", messages);


    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      temperature: 0.9,
      top_p: 0.95,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      n: 3,
      messages
    });

    const cands = (resp.choices || [])
      .map(c => (c.message?.content || "").trim())
      .filter(Boolean)
      .map(s => s.replace(/\s+/g, " "))
      .map(s => s.replace(/\u3002+$/g, "。"));

    if (!cands.length) return res.status(502).json({ error: "no_candidates" });
    return res.json({ text: pickLeastSimilar(cands, banPhrases) });
  } catch (err) {
    return res.status(502).json({ error: "openai_failed", detail: String(err?.message || err) });
  }
});

// --- 静的配信 & 起動 ---
app.use(express.static(__dirname));
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
