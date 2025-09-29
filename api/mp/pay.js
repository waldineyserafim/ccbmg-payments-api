// api/mp/pay.js
import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPayment } from "../_mp.js";

// Tabelas de plano
const PLAN_MONTHS = { mensal: 1, trimestral: 3, semestral: 6 };
const PLAN_LABEL  = { mensal: "Mensal", trimestral: "Trimestral", semestral: "Semestral" };
const PLAN_PRICE  = { mensal: 30, trimestral: 85, semestral: 170 };

// CORS: produção + local
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

// Add months preservando fim de mês
function addMonthsSafe(d, m){
  const x=new Date(d); const day=x.getDate();
  x.setMonth(x.getMonth()+m);
  if(x.getDate()<day) x.setDate(0);
  return x;
}

export default async function handler(req, res){
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  // Detecta se o servidor está com token de TESTE (útil para defaults)
  const isTestServer = (process.env.MP_ACCESS_TOKEN || "").startsWith("TEST-");

  try {
    const { uid, planType = "mensal", formData } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType] || !formData) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const amount = Number(PLAN_PRICE[planType]);

    // Cria fatura "em_aberto"
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);
    const invRef = await db.collection("users").doc(uid)
      .collection("financeInvoices").add({
        planType,
        planName: PLAN_LABEL[planType],
        planStart: Timestamp.fromDate(start),
        planEnd:   Timestamp.fromDate(end),
        dueDate:   Timestamp.fromDate(end),
        amount,
        status: "em_aberto",
        recordedAt: FieldValue.serverTimestamp()
      });

    // Normaliza campos vindos do Brick
    const {
      token,                       // só cartão
      payment_method_id,           // "visa" | "master" | "pix" | "bolbradesco"...
      payment_type_id,             // "credit_card" | "debit_card" | "bank_transfer" | "ticket"
      issuer_id,
      installments,
      payer = {}
    } = formData;

    const payerEmail = payer.email || formData.email || "comprador+teste@ccbmg.dev";
    // CPF é obrigatório em cartão/ boleto no BR. Se vier vazio no sandbox, preenche com CPF de teste.
    const payerIdType   = (payer.identification && payer.identification.type) || "CPF";
    const payerIdNumber = (payer.identification && payer.identification.number)
                       || (isTestServer ? "19119119100" : undefined);

    // Monta o pagamento conforme método
    const body = {
      transaction_amount: amount,
      description: `Associação ${PLAN_LABEL[planType]}`,
      payment_method_id,                 // "master" | "pix" | "bolbradesco" ...
      installments: Number(installments || 1),
      external_reference: invRef.id,
      statement_descriptor: "CLUBE CAVALO",
      binary_mode: true,                 // resposta imediata (bom para sandbox)
      metadata: { uid, planType, invoiceId: invRef.id },
      payer: {
        email: payerEmail,
        identification: payerIdNumber ? { type: payerIdType, number: String(payerIdNumber) } : undefined,
        first_name: payer.first_name || "Cliente",
        last_name:  payer.last_name  || "CCBMG"
      }
    };

    // Regras por tipo
    const isCard = payment_type_id === "credit_card" || payment_type_id === "debit_card";
    const isPix  = payment_method_id === "pix" || payment_type_id === "pix" || payment_type_id === "bank_transfer";
    const isBoleto = payment_type_id === "ticket";

    if (isCard) {
      if (!token)   return res.status(400).json({ error: "Token do cartão ausente." });
      body.token = token;
      if (issuer_id) body.issuer_id = issuer_id;
    }
    // PIX não precisa de token
    // Boleto requer identificação (já resolvido acima) e nome do pagador.

    // Tenta criar pagamento
    let pay;
    try {
      pay = await mpPayment.create({ body });
    } catch (err) {
      // Extrai mensagem detalhada da API do MP
      const mpMsg =
        (err?.response?.data && (err.response.data.message || err.response.data.error || err.response.data.cause?.[0]?.description)) ||
        err?.message ||
        "Erro ao criar pagamento no Mercado Pago";
      // Atualiza fatura com erro
      await invRef.set({
        status: "erro",
        gatewayError: mpMsg,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return res.status(500).json({ error: mpMsg });
    }

    // Atualiza fatura
    const approved = pay.status === "approved";
    const patch = {
      status: approved ? "pago" : pay.status, // "pending" para PIX/boletos
      method: "MercadoPago",
      gatewayId: String(pay.id),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (approved && pay.date_approved) {
      patch.paidAt = Timestamp.fromDate(new Date(pay.date_approved));
    }
    await invRef.set(patch, { merge:true });

    // Atualiza summary (próximo vencimento)
    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set({
      planType,
      lastPayment: approved ? (patch.paidAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
      lastAmount: amount,
      nextDue: Timestamp.fromDate(end),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge:true });

    // Próxima ação para PIX/BOLETO
    let next_action = null;
    if (pay.status === "pending") {
      if (isPix) {
        const td = pay.point_of_interaction?.transaction_data;
        next_action = {
          type: "pix",
          qr: td?.qr_code,
          qr_base64: td?.qr_code_base64,
          link: td?.ticket_url || td?.external_resource_url || null
        };
      } else if (isBoleto) {
        const link = pay.transaction_details?.external_resource_url
          || pay.point_of_interaction?.transaction_data?.ticket_url
          || null;
        next_action = { type: "boleto", link };
      }
    }

    return res.status(200).json({
      id: pay.id,
      status: pay.status,
      status_detail: pay.status_detail,
      invoice_id: invRef.id,
      next_action
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
}
