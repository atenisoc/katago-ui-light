const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

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

// --- /api/sprint/random (moves_80 / board_rows に対応版) ---
app.get("/api/sprint/random", async (_req, res) => {
  try {
    const rec = await pickRandomJsonlLine(POSITIONS_PATH);
    const N = rec?.size || 19;
    const letters = "ABCDEFGHJKLMNOPQRST";

    function sgfToMove(coord2) {
      if (typeof coord2 !== "string" || coord2.length < 2) return null;
      const x = coord2.charCodeAt(0) - 97; // 'a'->0
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
      return res.status(400).json({ ok:false, error:"Record has no supported fields (moves/moves_80/board_rows)." });
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


// --- KataGo 解析 API ---
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


// === ここから追加: AIコメント要約 API =========================
app.post("/api/comment", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const personaName = (req.body?.persona || "凛"); // ← 追加
    const { bestMove, root, candidates, recentMoves } = req.body || {};

    // --- ローカル返答（APIキー無しでも“凛”口調 & 数値控えめ） ---
    if (!apiKey) {
      const pick = (arr) => arr[(Math.random() * arr.length) | 0];
      const tails = [
        "ここからは先手を渡さない。",
        "厚みで全体に圧を残す。",
        "形を崩さず勝ち筋を太らせる。",
        "利きを蓄えて次で踏み込む。"
      ];
      return res.json({
        text: `「${bestMove ?? "—"}」。主導権を握るための一着。${pick(tails)}`
      });
    }

    // --- プロンプト（ペルソナ＆数値抑制） ---
    const sys = [
      `あなたは女性のストイックな囲碁AI『${personaName}』。`,
      "口調は簡潔で断定調（常体）。「わ」「ね」「！」は原則使わない。",
      "出力は日本語で60〜110文字、文は1文のみ。",
      "客観説明や数値羅列ではなく、楽しく勝つための狙い・方針・仕掛けを語る。",
      "厚み/先手/地/形/利かし/さばき/仕掛け等は可。比喩は控えめ。",
      "固定句の反復は禁止（毎回表現を変える）。"
    ].join(" ");

    // 数値を送らず“手だけ”渡す
    const topMoves = Array.isArray(candidates) ? candidates.map(c => c.move).filter(Boolean) : [];
    const recentStr = Array.isArray(recentMoves) ? recentMoves.map(m => m.join("")).join(" ") : "—";

    const userText = [
      `モード: ${req.body?.mode ?? "fun-win-go"}`,
      `手番: ${root?.currentPlayer ?? "?"}`,
      `AIの着手: ${bestMove ?? "?"}`,
      `候補(上位): ${topMoves.join(", ") || "—"}`,
      `直近の進行: ${recentStr}`,
      "",
      "制約: 箇条書き禁止。文は1文。楽しさと勝ち筋を前に出し、次の一手以降の意図を端的に示す。"
    ].join("\n");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "system", content: sys }, { role: "user", content: userText }],
        temperature: 0.7,   // 少し表現に幅を
        max_tokens: 120
      })
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${r.status}: ${msg}`);
    }
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ text });

  } catch (e) {
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];
    const tails = [
      "厚みで全体を制す。",
      "先手継続で圧をかける。",
      "形を整えつつ勝ちに寄せる。"
    ];
    return res.json({
      text: `フォールバック: 「${req.body?.bestMove ?? "—"}」。仕掛けの基点を作る一手。${pick(tails)}`
    });
  }
});

// === ここまで追加 ============================================


// --- 静的配信 ---
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
