/*
 * aiComment.js — “直前との差”だけを信号化し、GPTに自由生成させる版
 * + フェーズ制御 & ACK ログ付き
 * 
 * ポリシー:
 *  - 数値は出さない。GPTへは符号（-1/0/+1）と最小の文脈だけ渡す
 *  - 固定の語彙・テンプレは持たない（intentByPos / trendWords / tailLex 等なし）
 *  - 大人の女性 / 冷静・論理型（ただし語尾プリセットは使わず、説明的指示のみ）
 *  - サーバ失敗時は表示を更新しない（前回表示を保持）
 */

const USE_SERVER = true;

(function () {
  // —— 表示ノード
  const el = document.createElement("div");
  el.id = "aiComment";
  el.className = "eval";
  el.textContent = "AIのコメント: —";
  const boardEl = document.getElementById("board");
  if (boardEl) boardEl.insertAdjacentElement("afterend", el);

  // —— パラメータ
  const persona = { name: "凛", style: { tone: "stoic-female", targetLen: [60, 110] } };
  const recentBuffer = []; // 直近出力の簡易記憶（反復抑止用）
  const MAX_RECENT = 12;
  const N = 19, LCOLS = "ABCDEFGHJKLMNOPQRST";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // —— “直前との差” 用の前回値（数値は保持するが表示しない）
  let lastWr = null, lastLead = null, lastStdev = null, lastConc = null, lastCount = null, lastPvHead = null;
  let lastPosCategory = null, lastMovesLen = null;

  // ノイズ除去の死帯域（内部用）
  const EPS = { wr: 0.005, lead: 0.2, stdev: 0.2, conc: 0.02 };

  function signDelta(curr, prev, eps = 0) {
    if (curr == null || prev == null) return 0;
    const d = curr - prev;
    if (Math.abs(d) <= eps) return 0;
    return d > 0 ? 1 : -1;
  }

  function classifyPos(move) {
    if (!move || typeof move !== "string") return "unknown";
    const x = LCOLS.indexOf(move[0]);
    const y = N - parseInt(move.slice(1), 10);
    if (x < 0 || isNaN(y)) return "unknown";
    const corner = (x <= 3 && y <= 3) || (x <= 3 && y >= N - 4) || (x >= N - 4 && y <= 3) || (x >= N - 4 && y >= N - 4);
    const edge = x <= 2 || x >= N - 3 || y <= 2 || y >= N - 3;
    return corner ? "corner" : edge ? "side" : "center";
  }

  // フェーズ推定（値は使うが表示しない）
  function detectPhase(root, candidates) {
    const lead = typeof root?.scoreLead === "number" ? root.scoreLead : null;
    const cnum = (candidates || []).length;
    const endish = (cnum > 0 && cnum <= 3) || (lead != null && Math.abs(lead) >= 7.5);
    const openingish = cnum >= 6;
    return endish ? "endgame" : openingish ? "opening" : "middle";
  }

  function dynamicTargetLen(baseRange, deltaLike, conc, phase) {
    let [lo, hi] = baseRange;
    const vol = Math.max(Math.abs(deltaLike || 0), 0.01) + (1 - (conc || 0));
    if (vol > 0.5) hi += 20;
    if (phase === "endgame") { lo -= 10; hi -= 10; }
    return [clamp(lo, 40, 200), clamp(hi, 60, 200)];
  }

  function pushRecent(s) {
    if (!s) return;
    recentBuffer.unshift(s);
    if (recentBuffer.length > MAX_RECENT) recentBuffer.pop();
  }

  // 集中/分散の合議（conc / 候補手数 / PV先頭入替）
  function focusSign(sConc, sCnt, sPv) {
    const sum = sConc + (-sCnt) + sPv; // 候補手数↑は分散方向なので符号反転
    return sum > 0 ? 1 : sum < 0 ? -1 : 0;
  }

  // —— フェーズ別の禁止ワード
  const PHASE_BAN = {
    opening: ["最終局面","終盤","寄せ","収束","勝ち切る","仕上げる","小さく刻む"],
    middle:  ["最終局面","終盤","寄せ","収束","勝ち切る"],
    endgame: []
  };
  let STRICT_PHASE = true;
  function buildPhaseBan(phase){
    if (!STRICT_PHASE) return [];
    return PHASE_BAN[phase] || [];
  }

  // ————————————————————————————————————————
  // メイン：コメント生成（サーバ優先／失敗時は無変更）
  // ————————————————————————————————————————
  async function describe({ bestMove, katago, moves }) {
    try {
      // 手数巻き戻しを検知 → 内部状態リセット
      const mlen = Array.isArray(moves) ? moves.length : null;
      if (lastMovesLen != null && mlen != null && mlen < lastMovesLen) resetTrend();
      lastMovesLen = mlen;

      const root = katago?.rootInfo ?? {};
      const top5 = (katago?.moveInfos || []).slice(0, 5);

      // 集中度 conc と候補手数・PV
      const visitsArr = top5.map(mi => mi?.visits || 0);
      const sumV = visitsArr.reduce((a, b) => a + b, 0);
      const conc = sumV > 0 ? Math.max(...visitsArr) / sumV : 0;
      const count = top5.length;
      const pvHead = top5?.[0]?.pv?.[0] || null;

      // 形勢・揺れ
      const wr    = typeof root?.winrate    === "number" ? root.winrate    : null;
      const lead  = typeof root?.scoreLead  === "number" ? root.scoreLead  : null;
      const stdev = typeof root?.scoreStdev === "number" ? root.scoreStdev : null;

      // 直前との差（符号化）
      const sWr   = signDelta(wr,   lastWr,   EPS.wr);
      const sLead = signDelta(lead, lastLead, EPS.lead);
      const sVol  = signDelta(stdev,lastStdev,EPS.stdev);
      const sConc = signDelta(conc, lastConc, EPS.conc);
      const sCnt  = signDelta(count,lastCount,0);
      const sPv   = (pvHead && lastPvHead) ? (pvHead === lastPvHead ? 0 : -1) : 0;

      // 前回値更新
      if (wr    != null) lastWr    = wr;
      if (lead  != null) lastLead  = lead;
      if (stdev != null) lastStdev = stdev;
      if (!Number.isNaN(conc))  lastConc  = conc;
      if (!Number.isNaN(count)) lastCount = count;
      if (pvHead) lastPvHead = pvHead;

      // 形勢（勝率優先、無いとき目差）
      const shapeSign = sWr || sLead || 0;
      const focus     = focusSign(sConc, sCnt, sPv);

      // 位置・フェーズ
      const pos   = classifyPos(bestMove);
      const phase = detectPhase(root, top5);

      const posPrev = lastPosCategory || null;
      const posChanged = posPrev ? (pos !== posPrev) : false;
      lastPosCategory = pos;

      const skeleton = {
        persona: { role: "adult-female-calm-analytical" },
        context: {
          phase,
          pos: { current: pos, prev: posPrev, changed: posChanged }
        },
        trend: {
          shape: shapeSign,
          volatility: sVol,
          focus: focus
        },
        extras: {
          candidates: count,
          conc: { current: conc, deltaSign: sConc },
          pv: { headChanged: sPv === -1 }
        },
        directives: {
          no_numbers_in_text: true,
          no_coordinates_in_text: true,
          single_or_two_sentences: true,
          avoid_exclamations: true,
          avoid_feminine_endings: true
        }
      };

      const lengthHint = dynamicTargetLen(persona.style.targetLen, shapeSign, conc, phase);
      const phaseBan = buildPhaseBan(phase);

      if (!USE_SERVER) throw new Error("server_disabled");

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "free-signal-comment",
          skeleton,
          banPhrases: [...recentBuffer, ...phaseBan],
          lengthHint
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(t));

      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const text = (j?.text || "").trim();

      function violatesPhase(text, bans) {
        if (!text) return false;
        return bans.some(w => w && text.includes(w));
      }

      const DEBUG_ACK = true;

      if (text && !violatesPhase(text, phaseBan)) {
        el.textContent = "AIのコメント: " + text;
        pushRecent(text);
        if (DEBUG_ACK) console.info("[ACK] phase=%s allowed -> %s", phase, text);
        return;
      } else {
        if (DEBUG_ACK) console.info("[ACK] phase=%s BLOCKED. bans=%o, text=%s", phase, phaseBan, text);
        return; // 表示更新なし
      }
    } catch {
      return; // サーバ失敗時は前回表示維持
    }
  }

  // 内部状態リセット
  function resetTrend() {
    lastWr = lastLead = lastStdev = lastConc = lastCount = lastPvHead = null;
    lastPosCategory = null;
    lastMovesLen = null;
  }

  // 公開API
  window.AiMoveNLP = {
    describe,
    resetTrend,
    mountEl: el,
    setPersona(p) { Object.assign(persona, p || {}); },
    setStrictPhase(flag) { STRICT_PHASE = !!flag; }
  };
})();
