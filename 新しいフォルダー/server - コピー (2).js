/**
 * Minimal Express server with Sprint endpoints.
 * (If you already have server.js bridging KataGo, merge only the "SPRINT" parts.)
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- Sprint data loader ---
const SPRINT_JSONL = path.join(__dirname, "positions_80_clean.jsonl");

function loadSprintPositions(p) {
  try {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.map(l => JSON.parse(l));
  } catch (e) {
    console.warn("[Sprint] cannot read", p, e.message);
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
      if (ch === 'B' || ch === 'W') stones.push({ color: ch, x, y });
    }
  }
  return stones;
}
const SPRINTS = loadSprintPositions(SPRINT_JSONL);

app.get("/api/sprint/random", (_req, res) => {
  if (!SPRINTS.length) return res.status(404).json({ ok:false, error:"no sprint data" });
  const e = SPRINTS[Math.floor(Math.random()*SPRINTS.length)];
  res.json({
    ok:true,
    id: e.id,
    player_to_move: e.player_to_move,
    komi: Number(e.komi ?? 6.5),
    result: e.result ?? null,
    stones: boardRowsToStones(e),
  });
});
app.get("/api/sprint/byId", (req, res) => {
  const id = req.query.id;
  const e = SPRINTS.find(x => x.id === id);
  if (!e) return res.status(404).json({ ok:false, error:"id not found" });
  res.json({
    ok:true,
    id: e.id,
    player_to_move: e.player_to_move,
    komi: Number(e.komi ?? 6.5),
    result: e.result ?? null,
    stones: boardRowsToStones(e),
  });
});

// Fallback to index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => console.log("Server listening on http://localhost:" + PORT));
