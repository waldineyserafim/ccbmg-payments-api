import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPreference } from "../_mp.js";

const PLAN_MONTHS = { mensal: 1, trimestral: 3, semestral: 6 };
const PLAN_LABEL  = { mensal: "Mensal", trimestral: "Trimestral", semestral: "Semestral" };
const PLAN_PRICE  = { mensal: 30, trimestral: 85, semestral: 170 };

// -------- CORS (produção + local) --------
const ORIGINS = new Set([
  "https://clubedocavalobonfim.com.br",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000"
]);

function setCors(res, origin) {
  res.setHeader("Vary", "Origin");
  if (origin && ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://clubedocavalobonfim.com.br");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function addMonthsSafe(d, m) {
  const x = new Date(d); const day = x.getDate();
  x.setMonth(x.getMonth() + m);
  if (x.getDate() < day) x.setDate(0);
  return x;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") return res.status(405).end();

    const { uid, planType = "mensal" } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType]) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const amount = PLAN_PRICE[planType];

    // período do plano
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);
    const due   = end;

    // cria fatura em_aberto
    const invRef = await db.collection("users").doc(uid)
      .collection("financeInvoices").add({
        planType, planName: PLAN_LABEL[planType],
        planStart: Timestamp.fromDate(start),
        planEnd: Timestamp.fromDate(end),
        dueDate: Timestamp.fromDate(due),
        amount: Number(amount),
        status: "em_aberto",
        recordedAt: FieldValue.serverTimestamp()
      });

    // preferência Checkout Pro
    const pref = await mpPreference.create({
      body: {
        items: [{
          id: invRef.id,
          title: `Associação ${PLAN_LABEL[planType]}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: Number(amount)
        }],
        metadata: { uid, invoiceId: invRef.id, planType },
        notification_url: `https://${req.headers.host}/api/mp/webhook`,
        back_urls: {
          success: `https://clubedocavalobonfim.com.br/pay-success.html`,
          pending: `https://clubedocavalobonfim.com.br/pay.html`,
          failure: `https://clubedocavalobonfim.com.br/pay.html`
        },
        auto_return: "approved"
      }
    });

    // --- Escolha correta do link (sandbox x produção) ---
    const token = process.env.MP_ACCESS_TOKEN || "";
    const isTestEnv = token.startsWith("TEST-");

    // URLs cruas que a API retornou (para debug)
    const rawInit   = pref.init_point || null;
    const rawSandbox= pref.sandbox_init_point || null;

    // Fallbacks defensivos para garantir sandbox/prod coerente
    const toSandbox = (url) =>
      url ? url.replace("://www.mercadopago.com", "://sandbox.mercadopago.com") : null;
    const toProd = (url) =>
      url ? url.replace("://sandbox.mercadopago.com", "://www.mercadopago.com") : null;

    let init_point;
    if (isTestEnv) {
      init_point = rawSandbox || toSandbox(rawInit) || rawInit; // força sandbox
    } else {
      init_point = rawInit || toProd(rawSandbox) || rawSandbox; // produção
    }

    await invRef.update({ paymentUrl: init_point, preferenceId: pref.id });

    return res.status(200).json({
      init_point,
      preference_id: pref.id,
      // campos extras de debug (úteis só durante testes):
      env: isTestEnv ? "sandbox (TEST token)" : "production",
      raw_init_point: rawInit,
      raw_sandbox_init_point: rawSandbox
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
