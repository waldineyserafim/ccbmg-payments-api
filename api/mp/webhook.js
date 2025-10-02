// api/mp/webhook.js
import fetch from "node-fetch";
import { db, Timestamp } from "../_firebase.js";

// (opcional) verificação de assinatura — pode simplificar se não estiver usando a V2 com secret
function isFromMP(req) {
  // Se já configurou MP_WEBHOOK_SECRET e assinatura x-signature, valide aqui.
  // Caso não, retorne true e ajuste depois.
  return true;
}

const accessToken =
  process.env.MP_ENV === "live"
    ? process.env.MP_ACCESS_TOKEN_LIVE
    : process.env.MP_ACCESS_TOKEN_TEST;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end();
    if (!isFromMP(req)) return res.status(401).send("invalid signature");

    const body = req.body || {};
    // MP envia diferentes formatos; pegue o id do pagamento
    const topic = body.type || body.topic || body.action || "";
    let paymentId = null;

    if (topic.includes("payment")) {
      paymentId = body.data?.id || body.id || body.resource?.split("/").pop();
    }

    if (!paymentId) {
      return res.status(200).send("ok");
    }

    // Consulta o pagamento
    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const pay = await payRes.json();

    if (String(pay.status).toLowerCase() !== "approved") {
      // ignorar pagamentos não aprovados
      return res.status(200).send("ignored");
    }

    // Recupera o external_reference com uid + invoiceId
    let ref = {};
    try { ref = JSON.parse(pay.external_reference || "{}"); } catch {}
    const uid = ref.uid;
    const invoiceId = ref.invoiceId;

    if (!uid || !invoiceId) {
      console.warn("Webhook: external_reference sem uid/invoiceId", pay.external_reference);
      return res.status(200).send("no-ref");
    }

    // ===== Cálculos de vigência do plano =====
    // months pode estar na fatura; busque-a:
    const invRef = db.collection("users").doc(uid).collection("invoices").doc(invoiceId);
    const invSnap = await invRef.get();
    const inv = invSnap.exists ? invSnap.data() : {};
    const months = Number(inv.months || 1);

    const paidAt = Timestamp.now();
    // planEnd = hoje + months (ajuste se você usa outra regra)
    const planEndDate = new Date();
    planEndDate.setMonth(planEndDate.getMonth() + months);
    const planEnd = Timestamp.fromDate(planEndDate);

    // ===== Atualiza a fatura =====
    await invRef.set(
      {
        status: "pago",
        paidAt,
        mp: {
          ...(inv.mp || {}),
          paymentId: pay.id,
          status: pay.status,
          status_detail: pay.status_detail,
          payer: { id: pay.payer?.id || null, email: pay.payer?.email || null },
        },
        planEnd,
      },
      { merge: true }
    );

    // ===== Atualiza summary (zera pendência) =====
    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set(
      {
        lastPayment: paidAt,
        lastAmount: Number(inv.amount || pay.transaction_amount || 0),
        activeUntil: planEnd,
        nextDue: planEnd,          // você pode usar a mesma data; alguns preferem +1 dia
        balance: 0,                // MUITO IMPORTANTE para getUserStatus()
        updatedAt: Timestamp.now(),
        exempt: false,
      },
      { merge: true }
    );

    // ===== Atualiza perfil do usuário =====
    const userRef = db.collection("users").doc(uid);
    await userRef.set(
      {
        ativo: true,
        // coloque um texto que NÃO contenha "pend"
        status: "Em dia",
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );

    return res.status(200).send("ok");
  } catch (e) {
    console.error("MP webhook error", e);
    return res.status(500).send("error");
  }
}

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };
