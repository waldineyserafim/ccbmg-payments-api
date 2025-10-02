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

    const status = String(pay.status || "").toLowerCase();
    const detail = String(pay.status_detail || "").toLowerCase();

    // === Estados úteis ===
    const isApproved = status === "approved" || detail === "accredited"; // boleto compensado
    const isExpiredOrCancelled =
      status === "cancelled" || /expired|rejected/.test(detail);

    // >>> Referências: preferimos external_reference "uid|invoiceId"
    const metadata = pay?.metadata || {};
    let uid = metadata.uid || metadata.userId || metadata.user_id || null;
    let invoiceId = null;

    const ext = pay?.external_reference;
    if (typeof ext === "string") {
      // formatos aceitos:
      // - "uid|invoiceId" (preferido)
      // - "invoiceId" (legado)
      if (ext.includes("|")) {
        const [maybeUid, maybeInvoice] = ext.split("|");
        if (maybeUid && maybeInvoice) {
          uid = uid || maybeUid;
          invoiceId = maybeInvoice;
        }
      } else {
        // legado: external_reference somente com o id da fatura
        invoiceId = ext;
      }

      // se alguém mudar para JSON no futuro, tenta extrair
      if (/^\s*{/.test(ext)) {
        try {
          const j = JSON.parse(ext);
          uid = uid || j.uid || j.userId || j.user_id || uid;
          invoiceId = j.invoiceId || invoiceId;
        } catch {}
      }
    } else if (ext && typeof ext === "object") {
      uid = uid || ext.uid || ext.userId || ext.user_id || uid;
      invoiceId = ext.invoiceId || invoiceId;
    }

    if (!uid || !invoiceId) {
      console.warn("Webhook: sem uid/invoiceId utilizáveis", { uid, invoiceId, ext, metadata, paymentId });
      return res.status(200).send("no-ref");
    }

    // Caminho da fatura (alinhado ao pay.js)
    const invRef = db.collection("users").doc(uid).collection("financeInvoices").doc(invoiceId);
    const invSnap = await invRef.get();
    const inv = invSnap.exists ? invSnap.data() : {};

    // Utilitários de datas já salvos na fatura (preferência ao que veio da invoice)
    const paidAt = pay.date_approved ? Timestamp.fromDate(new Date(pay.date_approved)) : Timestamp.now();
    const planEnd = inv?.planEnd || null;
    const amount = inv?.amount ?? pay?.transaction_amount ?? 0;

    // === Atualizações por estado ===
    if (isApproved) {
      // Fatura aprovada
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
            payment_method_id: pay?.payment_method_id || null,
            payment_type_id: pay?.payment_type_id || null,
            payer: { id: pay?.payer?.id || null, email: pay?.payer?.email || null },
          }
        },
        { merge: true }
      );

      // Summary
      const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
      await summaryRef.set(
        {
          lastPayment: paidAt,
          lastAmount: Number(amount || 0),
          activeUntil: planEnd || null,
          nextDue: planEnd || null, // ajuste se preferir +1 dia
          balance: 0,
          exempt: false,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Perfil do usuário
      const userRef = db.collection("users").doc(uid);
      await userRef.set(
        {
          ativo: true,
          status: "Em dia",
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return res.status(200).send("ok");
    }

    if (isExpiredOrCancelled) {
      // Marcar fatura como expirada/cancelada (útil para boleto vencido)
      await invRef.set(
        {
          status: "expirado",
          updatedAt: FieldValue.serverTimestamp(),
          mp: {
            ...(inv.mp || {}),
            paymentId: pay.id,
            status: pay.status,
            status_detail: pay.status_detail
          }
        },
        { merge: true }
      );
      return res.status(200).send("expired");
    }

    // Outros estados (pending, in_process, etc.) — não alteramos nada
    return res.status(200).send("ignored");
  } catch (e) {
    console.error("MP webhook error", e);
    return res.status(500).send("error");
  }
}

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };
