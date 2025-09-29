// api/mp/pay.js
import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPayment } from "../_mp.js";

// preços e ciclos
const PLAN_MONTHS = { mensal: 1, trimestral: 3, semestral: 6 };
const PLAN_LABEL  = { mensal: "Mensal", trimestral: "Trimestral", semestral: "Semestral" };
const PLAN_PRICE  = { mensal: 30, trimestral: 85, semestral: 170 };

// CORS (produção + local)
const ORIGINS = new Set([
  "https://clubedocavalobonfim.com.br",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000"
]);
function setCors(res, origin) {
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Origin",
    origin && ORIGINS.has(origin) ? origin : "https://clubedocavalobonfim.com.br"
  );
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

    const { uid, planType = "mensal", formData } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType] || !formData?.token) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const amount = PLAN_PRICE[planType];

    // cria o ciclo e a fatura "em_aberto"
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);
    const invRef = await db.collection("users").doc(uid)
      .collection("financeInvoices").add({
        planType, planName: PLAN_LABEL[planType],
        planStart: Timestamp.fromDate(start),
        planEnd:   Timestamp.fromDate(end),
        dueDate:   Timestamp.fromDate(end),
        amount: Number(amount),
        status: "em_aberto",
        recordedAt: FieldValue.serverTimestamp()
      });

    // dados vindos do Brick
    const token               = formData.token;
    const payment_method_id   = formData.payment_method_id;
    const issuer_id           = formData.issuer_id;
    const installments        = Number(formData.installments || 1);
    const payerEmail          = formData.payer?.email || formData.email;
    const idType              = formData.payer?.identification?.type  || formData.identificationType  || "CPF";
    const idNumber            = formData.payer?.identification?.number|| formData.identificationNumber;

    // cria pagamento (SDK v2)
    const pay = await mpPayment.create({
      body: {
        token,
        issuer_id,
        payment_method_id,
        transaction_amount: Number(amount),
        installments,
        description: `Associação ${PLAN_LABEL[planType]}`,
        binary_mode: true,                  // resposta imediata (bom para sandbox)
        external_reference: invRef.id,
        metadata: { uid, planType, invoiceId: invRef.id },
        payer: {
          email: payerEmail,
          identification: idNumber ? { type: idType, number: String(idNumber) } : undefined
        }
      }
    });

    // baixa fatura conforme resultado
    const approved = pay.status === "approved";
    const patch = {
      status: approved ? "pago" : pay.status,
      method: "MercadoPago",
      gatewayId: String(pay.id),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (approved && pay.date_approved) {
      patch.paidAt = Timestamp.fromDate(new Date(pay.date_approved));
    }
    await invRef.set(patch, { merge: true });

    // atualiza summary
    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set({
      planType,
      lastPayment: approved ? patch.paidAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      lastAmount: Number(amount),
      nextDue: Timestamp.fromDate(end),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({
      id: pay.id,
      status: pay.status,
      status_detail: pay.status_detail,
      invoice_id: invRef.id
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
