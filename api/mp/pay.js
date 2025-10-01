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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
}

// Add months preservando fim de mês
function addMonthsSafe(d, m){
  const x=new Date(d); const day=x.getDate();
  x.setMonth(x.getMonth()+m);
  if(x.getDate()<day) x.setDate(0);
  return x;
}

// Validação simples de CPF
function isValidCPF(cpf) {
  const v = String(cpf || "").replace(/\D/g,"");
  if (!/^\d{11}$/.test(v) || /^(\d)\1{10}$/.test(v)) return false;
  const calc = (base) => {
    let sum = 0;
    for (let i=0;i<base.length;i++) sum += parseInt(base[i],10) * (base.length+1-i);
    const r = sum % 11;
    return (r < 2) ? 0 : 11 - r;
  };
  const d1 = calc(v.slice(0,9));
  const d2 = calc(v.slice(0,9)+d1);
  return v.endsWith(`${d1}${d2}`);
}

function unwrapMpError(err) {
  const data = err?.response?.data || {};
  const cause = Array.isArray(data?.cause) && data.cause.length ? data.cause[0] : null;
  const description =
    cause?.description ||
    data?.error_description ||
    data?.message ||
    data?.error ||
    err?.message ||
    "Erro ao criar pagamento no Mercado Pago";
  const code = cause?.code || data?.status || err?.response?.status || "unknown";
  return { description, code, raw: data };
}

// ===== E-mail sintético quando necessário =====
const VALID_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// usa domínio reservado (sempre aceito) e só alfanumérico
function synthEmail(uid = "user") {
  const clean = String(uid).replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "user";
  return `user-${clean}@example.com`;
}

export default async function handler(req, res){
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  const origin = req.headers.origin || "";
  const isLocalOrigin = /localhost|127\.0\.0\.1/.test(origin);
  const isTestEnv = String(process.env.MP_ENV || "").toUpperCase() === "TEST" || isLocalOrigin;

  try {
    const { uid, planType = "mensal", formData = {}, payer: payerTop = {} } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType]) {
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

    // ===== Normaliza campos do Brick (suporta snake_case e camelCase)
    const token             = formData.token;
    const payment_method_id = formData.payment_method_id || formData.paymentMethodId || formData.payment_method || formData.paymentMethod;
    const payment_type_id   = formData.payment_type_id   || formData.paymentTypeId;
    const issuer_id         = formData.issuer_id         || formData.issuerId;
    const installments      = formData.installments;
    const idempotencyKey    = formData.idempotencyKey;

    // payer pode vir no formData/payer ou no topo
    const payerForm = formData.payer || {};
    let email = (payerForm.email || payerTop.email || formData.email || "").trim();

    // identification (CPF)
    let idType   = (payerForm.identification?.type) || (payerTop.identification?.type) || "CPF";
    let idNumber = (payerForm.identification?.number) || (payerTop.identification?.number) || "";

    // nomes
    const firstName =
      payerForm.firstName || payerTop.firstName || payerForm.first_name || payerTop.first_name || undefined;
    const lastName  =
      payerForm.lastName  || payerTop.lastName  || payerForm.last_name  || payerTop.last_name  || undefined;
    const fullName  = payerForm.name || payerTop.name || undefined;

    // Regras por tipo
    const isCard   = payment_type_id === "credit_card" || payment_type_id === "debit_card" || (!payment_type_id && token); // fallback
    const isPix    = payment_method_id === "pix" || payment_type_id === "pix" || payment_type_id === "bank_transfer";
    const isBoleto = payment_type_id === "ticket" || payment_method_id === "bolbradesco";

    // Validações específicas do Cartão
    if (isCard) {
      if (!token) {
        return res.status(400).json({ error: "Token do cartão ausente (formData.token)." });
      }
      if (!payment_method_id) {
        return res.status(400).json({ error: "payment_method_id ausente (ex.: 'visa', 'master')." });
      }
    }

    // CPF obrigatório para cartão e boleto
    if (isCard || isBoleto) {
      if (!isValidCPF(idNumber)) {
        if (isTestEnv) {
          idNumber = "19119119100"; // CPF de teste
          idType = "CPF";
        } else {
          return res.status(400).json({ error: "CPF do pagador é obrigatório para cartão/boleto." });
        }
      }
    }

    // ===== Regras de e-mail =====
    // PIX: não enviar e-mail
    // Cartão/Boleto: obrigatório. Se vier vazio/ruim, gera um sintético infalível.
    if (isPix) {
      email = ""; // garantimos que não será enviado
    } else if (isCard || isBoleto) {
      if (!VALID_EMAIL.test(email)) {
        email = synthEmail(uid); // ex.: user-abc123@example.com
      }
      if (!VALID_EMAIL.test(email)) {
        email = "user@example.com"; // fallback final
      }
    }

    // Monta payer para o MP
    const mpPayer = {
      ...(isPix ? {} : { email }),     // NÃO manda email no PIX
      identification: (isCard || isBoleto) ? { type: idType, number: String(idNumber) } : undefined,
      first_name: firstName || fullName || "Cliente",
      last_name:  lastName  || (fullName ? "" : "CCBMG")
    };

    // Monta o pagamento conforme método
    const body = {
      transaction_amount: amount,
      description: `Associação ${PLAN_LABEL[planType]}`,
      payment_method_id,                 // "master" | "pix" | "bolbradesco" ...
      installments: Number(installments || 1),
      external_reference: invRef.id,
      statement_descriptor: "CLUBE CAVALO",
      binary_mode: true,
      metadata: { uid, planType, invoiceId: invRef.id, source: "brick" },
      payer: mpPayer
    };

    if (isCard) {
      body.token = token;
      if (issuer_id) body.issuer_id = issuer_id;
    }
    // PIX não precisa de token

    // Idempotência (gera se não veio do front)
    const idem = idempotencyKey || `ikey-${uid}-${Date.now()}`;

    // Tenta criar pagamento
    let pay;
    try {
      pay = await mpPayment.create({
        body,
        requestOptions: { idempotencyKey: idem }
      });
    } catch (err) {
      const { description, code, raw } = unwrapMpError(err);

      const isPolicy = /policy .*unauthorized|At least one policy returned UNAUTHORIZED/i.test(description);
      await invRef.set({
        status: "erro",
        gatewayError: description,
        gatewayCode: code,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      return res.status(500).json({
        error: description,
        code: raw?.status || code || "unknown",
        hint: isPolicy
          ? "Ambientes trocados ou app diferente: Access Token do servidor e Public Key do front DEVEM ser da mesma 'Credenciais de teste' do MESMO app."
          : null,
        debug: isTestEnv ? {
          method: isPix ? "pix" : (isCard ? "card" : (isBoleto ? "boleto" : "other")),
          sentEmail: isPix ? "(omitted)" : email,
          payment_method_id,
          payment_type_id,
          hasToken: !!token
        } : undefined
      });
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

    // Próxima ação para PIX/BOLETO (retorna códigos copiáveis)
    let next_action = null;
    if (pay.status === "pending") {
      if (isPix) {
        const td = pay.point_of_interaction?.transaction_data;
        next_action = {
          type: "pix",
          copy_and_paste: td?.qr_code || null,        // código PIX
          qr_base64: td?.qr_code_base64 || null,      // QR em base64
          link: td?.ticket_url || td?.external_resource_url || null
        };
      } else if (isBoleto) {
        const td = pay.transaction_details || {};
        const poi = pay.point_of_interaction?.transaction_data || {};
        const barcode =
          td?.barcode ||
          td?.barcode_content ||
          poi?.barcode ||
          poi?.qr_code ||   // alguns emissores entregam aqui
          null;

        const link = td?.external_resource_url || poi?.ticket_url || null;

        next_action = { type: "boleto", barcode, link };
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
