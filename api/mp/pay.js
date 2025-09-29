// api/mp/pay.js
import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPayment } from "../_mp.js";

// Preços e ciclos
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

function addMonthsSafe(d, m){
  const x=new Date(d); const day=x.getDate();
  x.setMonth(x.getMonth()+m);
  if(x.getDate()<day) x.setDate(0);
  return x;
}

export default async function handler(req, res){
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();

  try{
    if (req.method !== "POST") return res.status(405).end();

    // formData vem do Payment Brick (pode ser cartão, pix ou boleto)
    const { uid, planType = "mensal", formData } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType] || !formData) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const amount = PLAN_PRICE[planType];

    // Cria ciclo e fatura "em_aberto"
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

    // Normalizamos os campos do Brick
    const token             = formData.token; // só para cartão
    const payment_method_id = formData.payment_method_id; // "visa", "master", "pix", "bolbradesco"...
    const payment_type_id   = formData.payment_type_id;   // "credit_card" | "debit_card" | "pix" | "ticket"
    const issuer_id         = formData.issuer_id;
    const installments      = Number(formData.installments || 1);
    const email             = formData.payer?.email || formData.email; // email do pagador
    const idType            = formData.payer?.identification?.type  || formData.identificationType  || "CPF";
    const idNumber          = formData.payer?.identification?.number|| formData.identificationNumber;

    // Monta o corpo do pagamento conforme o método
    const body = {
      transaction_amount: Number(amount),
      description: `Associação ${PLAN_LABEL[planType]}`,
      payment_method_id,           // "visa"/"master"/"pix"/"bolbradesco"...
      binary_mode: true,           // resposta imediata (ótimo no sandbox)
      installments,                // só impacta cartão
      external_reference: invRef.id,
      metadata: { uid, planType, invoiceId: invRef.id },
      payer: {
        email: email,
        identification: idNumber ? { type: idType, number: String(idNumber) } : undefined
      }
    };

    if (payment_type_id === "credit_card" || payment_type_id === "debit_card") {
      body.token = token;          // obrigatório para cartão
      body.issuer_id = issuer_id;
    }
    // PIX e Boleto NÃO precisam de token.
    // Para Boleto no BR, o método costuma ser "bolbradesco" (o Brick envia automaticamente).

    // Cria o pagamento
    const pay = await mpPayment.create({ body });

    // Atualiza fatura conforme resultado
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

    // Atualiza summary (próximo vencimento já definido)
    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set({
      planType,
      lastPayment: approved ? (patch.paidAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
      lastAmount: Number(amount),
      nextDue: Timestamp.fromDate(end),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge:true });

    // Monta "próxima ação" para PIX/BOLETO (abrir link/código)
    let next_action = null;
    if (pay.status === "pending") {
      if (payment_method_id === "pix" || payment_type_id === "pix") {
        const td = pay.point_of_interaction?.transaction_data;
        next_action = {
          type: "pix",
          qr: td?.qr_code,
          qr_base64: td?.qr_code_base64,
          link: td?.ticket_url || td?.external_resource_url || null
        };
      } else if (payment_type_id === "ticket") {
        const link = pay.transaction_details?.external_resource_url
          || pay.point_of_interaction?.transaction_data?.ticket_url
          || null;
        next_action = { type: "boleto", link };
      }
    }

    return res.status(200).json({
      id: pay.id,
      status: pay.status,              // "approved" | "pending" | ...
      status_detail: pay.status_detail,
      invoice_id: invRef.id,
      next_action                       // dados para mostrar PIX/BOLETO no front
    });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
