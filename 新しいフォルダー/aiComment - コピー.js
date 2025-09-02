/**
 * AIの着手を一文で語る（女性/ストイック人格）。
 * 目的：楽しく勝つ・内容で語る。客観説明や数値羅列は控えめ。
 * - /api/comment が使えればそれを優先
 * - 失敗時はローカルで毎回変わる「凛」ボイスの一文を合成
 */
(function () {
  // ===== Persona 設定 =====
  const persona = {
    name: "凛",
    style: {
      // 常体/断定調、女性だけど甘さ控えめ。わ/ね/！は原則使わない
      tone: "stoic-female",
      // 文の長さ（概ね 60〜110 文字）
      targetLen: [60, 110]
    }
  };

  const host = document.querySelector(".hud") || document.body;
  const el = document.createElement("div");
  el.id = "aiComment";
  el.className = "eval";
  el.textContent = "AIのコメント: —";
  host.appendChild(el);

  // 直前勝率（手番視点）で増減演出（フォールバック用）
  let lastWr = null;

  function classifyPos(move) {
    if (!move || typeof move !== "string") return "不定";
    const L = "ABCDEFGHJKLMNOPQRST";
    const n = 19;
    const x = L.indexOf(move[0]);
    const y = n - parseInt(move.slice(1), 10);
    if (x < 0 || isNaN(y)) return "不定";
    const corner = (x <= 3 && y <= 3) || (x <= 3 && y >= n - 4) || (x >= n - 4 && y <= 3) || (x >= n - 4 && y >= n - 4);
    const edge = (x <= 2 || x >= n - 3 || y <= 2 || y >= n - 3);
    return corner ? "角" : edge ? "辺" : "中央";
  }
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  function localHeuristicText(bestMove, root, top5) {
    const wr = (typeof root?.winrate === "number") ? root.winrate : null; // 0..1
    const delta = (wr != null && lastWr != null) ? (wr - lastWr) : null;
    if (wr != null) lastWr = wr;

    const visits = Array.isArray(top5) ? top5.map(c => c.visits || 0) : [];
    const sumV = visits.reduce((a, b) => a + b, 0);
    const conc = sumV > 0 ? Math.max(...visits) / sumV : 0; // 一本化度合い

    const pos = classifyPos(bestMove);
    const posFlavor = {
      "角": ["地を先行して終盤を楽にする", "堅実に利益を確保する", "小さく稼ぎつつ先手を維持する"],
      "辺": ["外勢で盤面を締め付ける", "実利と厚みの釣り合いを取る", "手数を節約して主導権を握る"],
      "中央": ["厚みで全体を圧迫する", "相手の形を歪ませる", "先手を保って勝ち筋を太らせる"],
      "不定": ["バランスを崩さず圧をかける", "過剰な負担を避けつつ前に出る"]
    };

    let core;
    if (delta != null && delta >= 0.03) {
      core = ["勝率を伸ばしに行く", "主導権を握る", "勝ち筋を明確にする"];
    } else if (delta != null && delta <= -0.03) {
      core = ["苦しいが勝ちを拾いに行く", "形勢を戻すための勝負手", "相手の要点を突いて流れを変える"];
    } else if (conc >= 0.6) {
      core = ["最善が見えている", "読み筋が一本化している", "迷いの少ない選択"];
    } else if (conc <= 0.3) {
      core = ["選択肢が拮抗する難所", "応手しだいで景色が変わる", "含みを残す仕掛け"];
    } else {
      core = ["形を整えつつ前へ出る", "リスクを抑えて効率良く進める", "着実に勝ち筋を太らせる"];
    }

    const tail = [
      "私は次で圧を重ねる",
      "ここからは先手を離さない",
      "遊び心は残しつつ、勝ちを取りに行く",
      "相手の反発は読み切る"
    ];

    const head = `「${bestMove ?? "—"}」。`;
    const body = `${pick(core)}一手。${pick(posFlavor[pos])}。`;
    const end = pick(tail);
    return `${head}${body}${end}`;
  }

  async function describe({ bestMove, katago, moves }) {
    const root = katago?.rootInfo ?? {};
    const top5 = (katago?.moveInfos || []).slice(0, 5).map(mi => ({
      move: mi.move, winrate: mi.winrate, visits: mi.visits,
      pv: Array.isArray(mi.pv) ? mi.pv.slice(0, 8) : []
    }));
    const payload = {
      persona: persona.name,
      mode: "fun-win-go",
      bestMove,
      root: { currentPlayer: root.currentPlayer, winrate: root.winrate, scoreLead: root.scoreLead },
      candidates: top5,
      recentMoves: moves.slice(-8)
    };

    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).finally(() => clearTimeout(t));

      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const text = (j?.text || "").trim();
      if (text) {
        console.debug("[AiMoveNLP] used: server");
        el.textContent = "AIのコメント: " + text;
        if (typeof root.winrate === "number") lastWr = root.winrate;
        return;
      }
      throw new Error("empty");
    } catch {
      console.debug("[AiMoveNLP] used: fallback");
      const text = localHeuristicText(bestMove, root, top5);
      el.textContent = "AIのコメント: " + text;
    }
  }

  // 公開
  window.AiMoveNLP = { describe, mountEl: el, setPersona(p){ Object.assign(persona, p||{}); } };
})();
