// api/mp/webhook.js
import fetch from "node-fetch";
import { db, Timestamp, FieldValue } from "../_firebase.js";

// (opcional) verificação de assinatura — pode simplificar se não estiver usando a V2 com secret
function isFromMP(req) {
  // Se já configurou MP_WEBHOOK_SECRET e assinatura x-signature, valide aqui.
  // Caso não, retorne true e ajuste depois.
  return true;
}

const accessToken =
  (process.env.MP_ENV || "").toLowerCase() === "live"
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
      paymentId =
        body?.data?.id ||
        body?.id ||
        (typeof body.resource === "string" ? body.resource.split("/").pop() : null);
    }

    if (!paymentId) {
      return res.status(200).send("ok");
    }

    // Consulta o pagamento
    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const pay = await payRes.json();

    if (String(pay.status || "").toLowerCase() !== "approved") {
      // ignorar pagamentos não aprovados
      return res.status(200).send("ignored");
    }

    // >>> Pegamos uid do metadata; invoiceId do external_reference (ID "cru" da fatura)
    const metadata = pay?.metadata || {};
    const uid = metadata.uid || metadata.userId || metadata.user_id || null;

    let invoiceId = null;
    const ext = pay?.external_reference;
    if (typeof ext === "string") {
      invoiceId = ext; // seu pay.js envia o ID puro da fatura aqui
      // se alguém mudar para JSON no futuro, tenta extrair
      if (/^\s*{/.test(ext)) {
        try { invoiceId = JSON.parse(ext)?.invoiceId || invoiceId; } catch {}
      }
    } else if (ext && typeof ext === "object") {
      invoiceId = ext.invoiceId || null;
    }

    if (!uid || !invoiceId) {
      console.warn("Webhook: approved, mas sem uid/invoiceId", { uid, invoiceId, ext, metadata });
      return res.status(200).send("no-ref");
    }

    // >>> Coleção correta: financeInvoices (alinhado ao pay.js)
    const invRef = db.collection("users").doc(uid).collection("financeInvoices").doc(invoiceId);
    const invSnap = await invRef.get();
    const inv = invSnap.exists ? invSnap.data() : {};

    // Prefira planEnd já salvo na fatura; use paidAt do MP se existir
    const paidAt = pay.date_approved ? Timestamp.fromDate(new Date(pay.date_approved)) : Timestamp.now();
    const planEnd = inv?.planEnd || null;
    const amount = inv?.amount ?? pay?.transaction_amount ?? 0;

    // ===== Atualiza a fatura =====
    await invRef.set(
      {
        status: "pago",
        paidAt,
        method: "MercadoPago",
        gatewayId: String(pay.id),
        updatedAt: FieldValue.serverTimestamp(),
        mp: {
          ...(inv.mp || {}),
          paymentId: pay.id,
          status: pay.status,
          status_detail: pay.status_detail,
          payer: { id: pay?.payer?.id || null, email: pay?.payer?.email || null },
        }
      },
      { merge: true }
    );

    // ===== Atualiza summary (zera pendência e marca vigência) =====
    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set(
      {
        lastPayment: paidAt,
        lastAmount: Number(amount || 0),
        activeUntil: planEnd || null,
        nextDue: planEnd || null, // pode usar a mesma data; ajuste se preferir +1 dia
        balance: 0,               // MUITO IMPORTANTE para getUserStatus()
        exempt: false,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    // ===== Atualiza perfil do usuário =====
    const userRef = db.collection("users").doc(uid);
    await userRef.set(
      {
        ativo: true,
        // texto sem "pend" para não conflitar com seu getUserStatus()
        status: "Em dia",
        updatedAt: FieldValue.serverTimestamp()
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
