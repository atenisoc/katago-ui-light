/*
 * aiComment.js — 対戦AIの一言コメント生成
 * 目的:
 *   - UIの赤●が着手を示すので、コメントには記号や座標は出さない
 *   - 個性 × 囲碁知識 × 読みの“質感” を毎回揺らぎをもって生成
 *   - サーバー(/api/comment) があれば GPT-3.5 で自然文に、失敗時はローカル辞書でフォールバック
 */

const USE_SERVER = true; // ← サーバ経由で生成。ローカルのみ試すなら false

(function () {
  // ===== Persona =====
  const persona = {
    name: "凛",
    style: {
      tone: "stoic-female", // わ/ね/！は禁止、断定調ベース
      targetLen: [60, 110], // 文字数目安（状況で可変）
    },
  };

  // 直近の出力リングバッファ（重複回避用）
  const recentBuffer = [];
  const MAX_RECENT = 12;
  function pushRecent(s) {
    if (!s) return;
    recentBuffer.unshift(s);
    if (recentBuffer.length > MAX_RECENT) recentBuffer.pop();
  }

  // ===== DOM mount =====
  const host = document.querySelector(".hud") || document.body;
  const el = document.createElement("div");
  el.id = "aiComment";
  el.className = "eval";
  el.textContent = "AIのコメント: —";
  host.appendChild(el);

  // ===== Helpers =====
  const LCOLS = "ABCDEFGHJKLMNOPQRST"; // I抜き
  const N = 19;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  let lastWr = null; // 直近勝率（0..1）

  // 盤上の大まかな領域
  function classifyPos(move) {
    if (!move || typeof move !== "string") return "不定";
    const x = LCOLS.indexOf(move[0]);
    const y = N - parseInt(move.slice(1), 10);
    if (x < 0 || isNaN(y)) return "不定";
    const corner =
      (x <= 3 && y <= 3) ||
      (x <= 3 && y >= N - 4) ||
      (x >= N - 4 && y <= 3) ||
      (x >= N - 4 && y >= N - 4);
    const edge = x <= 2 || x >= N - 3 || y <= 2 || y >= N - 3;
    return corner ? "角" : edge ? "辺" : "中央";
  }

  // 中盤/終盤のざっくり判定
  function detectPhase(root, candidates) {
    const lead = typeof root?.scoreLead === "number" ? root.scoreLead : null;
    const cnum = (candidates || []).length;
    const endish = (cnum > 0 && cnum <= 3) || (lead != null && Math.abs(lead) >= 7.5);
    const openingish = cnum >= 6;
    return endish ? "endgame" : openingish ? "opening" : "middle";
  }

  // ===== 語彙バンク =====
  const intentByPos = {
    角: ["地合いを先行させる", "小さく稼いで先手を維持する", "寄せを見据える"],
    辺: ["外勢で盤面を締め付ける", "実利と厚みの均衡を取る", "主導権を握る"],
    中央: ["厚みで全体を圧迫する", "相手の形を歪ませる", "勝ち筋を太らせる"],
    不定: ["過剰な負担を避けて前に出る", "バランスを崩さず圧をかける"],
  };

  const closeOutLex = ["収束へ寄せる", "安全にまとめる", "細部を整える", "無理をせず収める"];

  const coreWhen = {
    up: ["最善が見えている", "勝ち筋を明確にする", "主導権を取り戻す"],
    down: ["苦しいが勝負を探る", "形勢を戻す勝負手", "流れを変える一手"],
    steady: ["形を整える", "リスクを抑えて進める", "差を太らせる"],
    spread: ["選択肢が拮抗する難所", "応手で景色が変わる", "含みを残して探る"],
    focus: ["読みが一本化している", "迷いの少ない選択", "一本道を通す"],
  };

  const feelLex = {
    up: ["風が変わる", "勝ち筋が太くなる"],
    down: ["足場が崩れる", "視界が霞む"],
    even: ["張り詰めた均衡", "細い糸でつながる"],
    pathHigh: ["一本道が見える", "迷いがない"],
    pathLow: ["景色が定まらない", "選択肢が散る"],
  };

  const tailLex = [
    "私は次で圧を重ねる",
    "ここからは先手を離さない",
    "勝ちに寄せる",
    "相手の反発は読み切る",
  ];

  function dynamicTargetLen(baseRange, delta, conc, phase) {
    let [lo, hi] = baseRange;
    const vol = Math.max(Math.abs(delta || 0), 0.01) + (1 - (conc || 0));
    if (vol > 0.5) hi += 20;
    if (phase === "endgame") {
      lo -= 10;
      hi -= 10;
    }
    return [clamp(lo, 40, 200), clamp(hi, 60, 200)];
  }
  function jitterRange([lo, hi]) {
    const j = ((Math.random() * 20) | 0) - 10;
    return [clamp(lo + j, 40, 200), clamp(hi + j, 60, 220)];
  }

  // ===== ローカル生成（フォールバック） =====
  function localHeuristicText(bestMove, root, topList) {
    const wr = typeof root?.winrate === "number" ? root.winrate : null;
    const delta = wr != null && lastWr != null ? wr - lastWr : null;
    if (wr != null) lastWr = wr;

    const visits = Array.isArray(topList) ? topList.map((c) => c.visits || 0) : [];
    const sumV = visits.reduce((a, b) => a + b, 0);
    const conc = sumV > 0 ? Math.max(...visits) / sumV : 0;

    const pos = classifyPos(bestMove);
    const phase = detectPhase(root, topList);

    const feelDelta =
      delta != null && delta >= 0.03
        ? pick(feelLex.up)
        : delta != null && delta <= -0.03
        ? pick(feelLex.down)
        : pick(feelLex.even);
    const feelPath =
      conc >= 0.6 ? pick(feelLex.pathHigh) : conc <= 0.3 ? pick(feelLex.pathLow) : null;

    const intents = intentByPos[pos] || intentByPos["不定"];

    let corePool;
    if (delta != null && delta >= 0.03) corePool = coreWhen.up;
    else if (delta != null && delta <= -0.03) corePool = coreWhen.down;
    else if (conc >= 0.6) corePool = coreWhen.focus;
    else if (conc <= 0.3) corePool = coreWhen.spread;
    else corePool = coreWhen.steady;

    const close = phase === "endgame" ? pick(closeOutLex) : null;

    // 文順序をシャッフルして自然な揺らぎを出す
    const chunks = shuffle([feelDelta, feelPath, pick(corePool), pick(intents), close]).filter(
      Boolean
    );

    const [lo, hi] = dynamicTargetLen(persona.style.targetLen, delta, conc, phase);
    const [jlo, jhi] = jitterRange([lo, hi]);
    const s = chunks.join("。") + "。";
    return s.length < jlo ? s + pick(tailLex) + "。" : s;
  }

  // ===== サーバー優先 =====
  async function describe({ bestMove, katago, moves }) {
    const root = katago?.rootInfo ?? {};
    const top5 = (katago?.moveInfos || [])
      .slice(0, 5)
      .map((mi) => ({
        move: mi.move,
        winrate: mi.winrate,
        visits: mi.visits,
        pv: Array.isArray(mi.pv) ? mi.pv.slice(0, 8) : [],
      }));

    const wr = typeof root?.winrate === "number" ? root.winrate : null;
    const delta = wr != null && lastWr != null ? wr - lastWr : null;
    const visits = Array.isArray(top5) ? top5.map((c) => c.visits || 0) : [];
    const sumV = visits.reduce((a, b) => a + b, 0);
    const conc = sumV > 0 ? Math.max(...visits) / sumV : 0;
    const pos = classifyPos(bestMove);
    const phase = detectPhase(root, top5);
    const feelDelta =
      delta != null && delta >= 0.03
        ? pick(feelLex.up)
        : delta != null && delta <= -0.03
        ? pick(feelLex.down)
        : pick(feelLex.even);
    const feelPath =
      conc >= 0.6 ? pick(feelLex.pathHigh) : conc <= 0.3 ? pick(feelLex.pathLow) : null;

    const skeleton = {
      intent: pick(intentByPos[pos]),
      feel: [feelDelta, feelPath].filter(Boolean),
      phase,
      pos,
      deltaBucket:
        delta == null
          ? "na"
          : delta >= 0.06
          ? "+6%"
          : delta >= 0.03
          ? "+3%"
          : delta <= -0.06
          ? "-6%"
          : delta <= -0.03
          ? "-3%"
          : "±",
      lead: root.scoreLead ?? null,
      conc,
    };

    const payload = {
      persona: persona.name,
      mode: "fun-win-go",
      skeleton,
      banPhrases: recentBuffer,
      lengthHint: dynamicTargetLen(persona.style.targetLen, delta, conc, phase),
    };

    try {

   if (!USE_SERVER) throw new Error("server_disabled");
   const controller = new AbortController();


      const t = setTimeout(() => controller.abort(), 2000);
      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(t));

      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const text = (j?.text || "").trim();
      if (text) {
        el.textContent = "AIのコメント: " + text;
        pushRecent(text);
        if (typeof root.winrate === "number") lastWr = root.winrate;
        return;
      }
      throw new Error("empty");
    } catch {
      const text = localHeuristicText(bestMove, root, top5);
      el.textContent = "AIのコメント: " + text;
      pushRecent(text);
    }
  }

  // ===== 公開API =====
  window.AiMoveNLP = {
    describe,
    mountEl: el,
    setPersona(p) {
      Object.assign(persona, p || {});
    },
  };
})();
