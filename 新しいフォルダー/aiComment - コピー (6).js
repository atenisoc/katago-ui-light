/*
 * aiComment.js — “直前との差”の信号だけをGPTへ渡し、自由生成させる版
 *  + フェーズ制御（開幕ハードゲート/訪問数ゲート/禁止語リスト）
 *  + 参考few-shot（ケースに応じて少量の参考文を渡し、コピペは事後検知）
 *  + ACKログ（許可/ブロックをconsoleに出力）
 *
 * ポリシー:
 *  - 表示に数値は出さない。GPTへは符号（-1/0/+1）と最小限の文脈のみ
 *  - 固定語彙やテンプレ辞書は持たない（intentByPos等なし）
 *  - サーバ失敗/規約違反時は表示更新しない（前回表示を保持）
 */

const USE_SERVER = true;

(function () {
  // —— 表示ノード
  const el = document.createElement("div");
  el.id = "aiComment";
  el.className = "eval";
  el.textContent = "Kaya’s Note: —";
  const boardEl = document.getElementById("board");
  if (boardEl) boardEl.insertAdjacentElement("afterend", el);

  // —— 設定
  const persona = { name: "凛", style: { tone: "stoic-female", targetLen: [60, 110] } };
  const recentBuffer = [];           // 直近出力の簡易記憶（反復抑止用）
  const MAX_RECENT = 12;
  const N = 19, LCOLS = "ABCDEFGHJKLMNOPQRST";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // —— “直前との差”のための前回値（表示には使わない）
  let lastWr = null, lastLead = null, lastStdev = null, lastConc = null, lastCount = null, lastPvHead = null;
  let lastPosCategory = null, lastMovesLen = null;

  // ノイズ除去の死帯域（内部用）
  const EPS = { wr: 0.005, lead: 0.2, stdev: 0.2, conc: 0.02 };

  // 開幕/探索薄い時のハードゲート
  const FORCE_OPENING_MOVES = 10;   // 例: 10手までは無条件でopening
  const MIN_VISITS_FOR_PHASE = 300; // 探索合計が小さい間はopening扱い

  // —— 正規表現の禁止語（phase別）
  const PHASE_BAN_RE = {
    opening: [/終盤/, /最終局面/, /寄せ/, /収束/, /勝ち切/, /仕上げ/, /小さく刻/],
    middle:  [/終盤/, /最終局面/, /寄せ/, /収束/, /勝ち切/],
    endgame: []
  };
  let STRICT_PHASE = true;

  // ———— utils ————
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
    const edge   = (x <= 2 || x >= N - 3 || y <= 2 || y >= N - 3);
    return corner ? "corner" : edge ? "side" : "center";
  }

  function detectPhase(root, candidates) {
    const lead = typeof root?.scoreLead === "number" ? root.scoreLead : null;
    const cnum = (candidates || []).length;
    // endgame条件は“十分手数が進んだ時だけ”有効化
    const enoughMoves = (lastMovesLen || 0) > 80;
    const endish = enoughMoves && ((cnum > 0 && cnum <= 3) || (lead != null && Math.abs(lead) >= 7.5));
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
    const sum = sConc + (-sCnt) + sPv; // 候補手数↑は分散方向（符号反転）
    return sum > 0 ? 1 : sum < 0 ? -1 : 0;
  }

  function buildPhaseBanRegex(phase) {
    if (!STRICT_PHASE) return [];
    return PHASE_BAN_RE[phase] || [];
  }

  function violatesRegex(text, bansRe) {
    if (!text) return false;
    return bansRe.some(re => re.test(text));
  }

  // —— 参考few-shot（ケースに合わせて少数だけ渡す）
  function buildReferences({ shape, volatility, focus }, { posPrev, posCurr }) {
    const refs = [];

    // 例①（形勢↑・揺れ↑・集中↓）
    if (shape > 0 && volatility > 0 && focus < 0) {
      refs.push("流れがこちらに寄り始めたかな。けれど手が広く、難しい。");
    }
    // 例②（形勢↓・揺れ↓・集中↑・隅→辺）
    if (shape < 0 && volatility < 0 && focus > 0 && posPrev === "corner" && posCurr === "side") {
      refs.push("流れを少し失ったか。だが、手は広くない、ミスはしない。機会があれば主導権を取り返す。");
    }
    // 例③（形勢＝・揺れ＝・集中↑）
    if (shape === 0 && volatility === 0 && focus > 0) {
      refs.push("均衡が続き、かつ一本道。細部の精度で差が出る。");
    }
    return refs.slice(0, 2); // 多すぎるとコピペ傾向が出るので最大2件
  }

  function plagiarized(text, refs) {
    if (!text || !Array.isArray(refs)) return false;
    return refs.some(r => r && text.includes(r));
  }

  // ————————————————————————————————————————
  // メイン：コメント生成（サーバ優先／失敗時・違反時は無変更）
  // ————————————————————————————————————————
  async function describe({ bestMove, katago, moves }) {
    try {
      // 手数巻き戻しを検知 → 内部状態リセット
      const mlen = Array.isArray(moves) ? moves.length : 0;
      if (lastMovesLen != null && mlen < lastMovesLen) resetTrend();
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

      // 位置・フェーズ（推定 → 開幕/探索薄い時は強制opening）
      const pos   = classifyPos(bestMove);
      let phase   = detectPhase(root, top5);
      if (mlen <= FORCE_OPENING_MOVES) phase = "opening";
      if (sumV < MIN_VISITS_FOR_PHASE) phase = "opening";

      const posPrev = lastPosCategory || null;
      const posChanged = posPrev ? (pos !== posPrev) : false;
      lastPosCategory = pos;

      // few-shot 参考を組み立て
      const references = buildReferences(
        { shape: shapeSign, volatility: sVol, focus },
        { posPrev, posCurr: pos }
      );

      // —— GPT に渡す“骨組み”。固定語彙なし、信号のみ。
      const skeleton = {
        persona: { role: "adult-female-calm-analytical" },
        context: {
          phase,
          pos: { current: pos, prev: posPrev, changed: posChanged }
        },
        trend: {
          shape: shapeSign,   // -1 | 0 | +1
          volatility: sVol,   // -1 | 0 | +1
          focus: focus        // -1 | 0 | +1
        },
        extras: {
          candidates: count,                          // 表示禁止（生成判断のみ）
          conc: { current: conc, deltaSign: sConc },  // 同上
          pv: { headChanged: sPv === -1 }             // 同上
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
      const phaseBanRe = buildPhaseBanRegex(phase);

      if (!USE_SERVER) throw new Error("server_disabled");

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);

      const payload = {
        mode: "free-signal-comment",
        skeleton,
        banPhrases: recentBuffer,                           // 直近重複だけ（文字列）
        phaseBansRegex: phaseBanRe.map(re => re.source),    // サーバ側で使えるなら正規表現ソースも渡す
        hardPhase: phase,                                   // "opening"強制などの強いヒント
        lengthHint,
        referenceExamples: references,                      // few-shot参考
        referenceDirectives: {
          purpose: "style_and_tone_guidance_only",
          do_not_copy_verbatim: true,
          require_paraphrase: true,
          keep_persona: "adult-female-calm-analytical",
          sentences: "1-2",
          no_numbers_or_coordinates: true,
          avoid_exclamations: true,
          avoid_feminine_endings: true
        }
      };

      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).finally(() => clearTimeout(t));

      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const text = (j?.text || "").trim();

      const DEBUG_ACK = true;

      if (text && !violatesRegex(text, phaseBanRe) && !plagiarized(text, references)) {
        el.textContent = "Kaya’s Note: " + text;
        pushRecent(text);
        if (DEBUG_ACK) console.info("[ACK] phase=%s allowed -> %s", phase, text);
        return;
      } else {
        if (DEBUG_ACK) console.info("[ACK] phase=%s BLOCKED (phase/plagiarism). refs=%o, text=%s", phase, references, text);
        return; // 表示更新なし（前回のまま）
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
