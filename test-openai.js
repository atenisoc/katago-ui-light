// test-openai.js
const express = require("express");
const OpenAI = require("openai");

const app = express();

// ---- OpenAI クライアント（project 必須）----
console.log("DEBUG OPENAI_PROJECT =", process.env.OPENAI_PROJECT);
console.log("DEBUG OPENAI_MODEL   =", process.env.OPENAI_MODEL);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT,
});

// ---- 疎通確認 /api/ping ----
app.get("/api/ping", async (req, res) => {
  try {
    const rsp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: "hello",
    });
    res.json({ ok: true, text: rsp.output_text });
  } catch (e) {
    console.error("PING ERROR", {
      status: e?.status, code: e?.code, type: e?.type,
      message: String(e?.message ?? e),
    });
    res.status(e?.status ?? 500).json({
      ok: false, error: String(e?.message ?? e),
      code: e?.code, type: e?.type,
    });
  }
});

const PORT = 5252; // 本番の5173とは別ポートに
app.listen(PORT, () => {
  console.log(`Test server listening on http://localhost:${PORT}`);
});
