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
    const { bestMove, root, candidates, recentMoves } = req.body || {};

    // APIキーが無い／使えない場合はローカル生成でフォールバック
    if (!apiKey) {
      const wr = (typeof root?.winrate === "number") ? Math.round(root.winrate * 100) : "—";
      const lead = (typeof root?.scoreLead === "number") ? Number(root.scoreLead).toFixed(1) : "—";
      return res.json({
        text: `ローカル生成: 「${bestMove ?? "—"}」。黒勝率${wr}%、黒のリード約${lead}目。無理せず厚み優先。`
      });
    }

    // Node18+ の fetch を利用（Node16 なら node-fetch を追加して下さい）
    const sys = "あなたは囲碁AIの解説者。出力は日本語で70〜120文字、専門用語少なめ、比喩控えめ、感情語は1語まで、文は1文だけ。";
    const userText = [
      `手番: ${root?.currentPlayer ?? "?"}`,
      `AIの着手: ${bestMove ?? "?"}`,
      `勝率(手番視点): ${typeof root?.winrate === "number" ? (root.winrate*100).toFixed(1) + "%" : "不明"}`,
      `平均リード(手番視点): ${typeof root?.scoreLead === "number" ? root.scoreLead.toFixed(1) + "目" : "不明"}`,
      `候補(上位): ${Array.isArray(candidates) ? candidates.map(c => `${c.move}(${Math.round((c.winrate||0)*100)}%/${c.visits}訪問)`).join(", ") : "—"}`,
      `直近の進行: ${Array.isArray(recentMoves) ? recentMoves.map(m => m.join("")).join(" ") : "—"}`,
      "",
      "制約: 箇条書き禁止。文は1文。指し手の狙い・方針を平易に。"
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
        temperature: 0.6,
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
    // エラー時も壊れないよう、短文で返す
    return res.json({
      text: `フォールバック: 「${req.body?.bestMove ?? "—"}」。堅実に地合いを崩さず形勢維持を狙った一手。`
    });
  }
});
// === ここまで追加 ============================================


// --- 静的配信 ---
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
