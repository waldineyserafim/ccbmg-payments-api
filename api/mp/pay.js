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

// SEMPRE usar e-mail sintético para satisfazer validações do MP (sem pedir ao usuário)
function synthEmail(uid = "user") {
  const clean = String(uid).replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "user";
  return `user-${clean}@example.com`; // domínio reservado para testes
}

export default async function handler(req, res){
  setCors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  // Ambiente aparente (apenas para debug)
  const origin = req.headers.origin || "";
  const isLocalOrigin = /localhost|127\.0\.0\.1/.test(origin);
  const isTestEnv = String(process.env.MP_ENV || "").toUpperCase() === "TEST" || isLocalOrigin;

  try {
    const {
      uid,
      planType = "mensal",
      formData = {},
      payer: payerTop = {},
      invoiceId: invoiceIdFromClient // <- NOVO: aceita invoiceId vindo do front
    } = req.body || {};

    if (!uid || !PLAN_MONTHS[planType]) {
      return res.status(400).json({ error: "Parâmetros inválidos" });
    }

    const amount = Number(PLAN_PRICE[planType]);

    // ====== Invoice: usa a do front se veio; senão cria como antes em financeInvoices
    let invDocRef;
    let invId = invoiceIdFromClient || null;

    if (invId) {
      // Usa o ID informado para manter o vínculo exato front<->webhook
      invDocRef = db.collection("users").doc(uid).collection("financeInvoices").doc(invId);
      const start = new Date(); start.setHours(0,0,0,0);
      const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);

      await invDocRef.set({
        planType,
        planName: PLAN_LABEL[planType],
        planStart: Timestamp.fromDate(start),
        planEnd:   Timestamp.fromDate(end),
        dueDate:   Timestamp.fromDate(end),
        amount,
        status: "em_aberto",
        recordedAt: FieldValue.serverTimestamp(),
        months: PLAN_MONTHS[planType]
      }, { merge: true });
    } else {
      // Sem invoiceId do front: cria como já fazia
      const start = new Date(); start.setHours(0,0,0,0);
      const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);
      invDocRef = await db.collection("users").doc(uid)
        .collection("financeInvoices").add({
          planType,
          planName: PLAN_LABEL[planType],
          planStart: Timestamp.fromDate(start),
          planEnd:   Timestamp.fromDate(end),
          dueDate:   Timestamp.fromDate(end),
          amount,
          status: "em_aberto",
          recordedAt: FieldValue.serverTimestamp(),
          months: PLAN_MONTHS[planType]
        });
      invId = invDocRef.id;
    }

    // ===== Normaliza campos do Brick (suporta snake_case e camelCase)
    const token             = formData.token;
    const payment_method_id = formData.payment_method_id || formData.paymentMethodId || formData.payment_method || formData.paymentMethod;
    const payment_type_id   = formData.payment_type_id   || formData.paymentTypeId;
    const issuer_id         = formData.issuer_id         || formData.issuerId;
    const installments      = formData.installments;
    const idempotencyKey    = formData.idempotencyKey;

    const payerForm = formData.payer || {};
    // identification (CPF)
    let idType   = (payerForm.identification?.type)   || (payerTop.identification?.type)   || "CPF";
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

    // ===== Regras de payer/email por método =====
    // - PIX: o MP exige que "payer" exista → enviamos obj mínimo + e-mail sintético
    // - Cartão/Boleto: sempre usamos e-mail sintético (evita rejeição por e-mail faltante)
    const emailToSend = (isCard || isBoleto || isPix) ? synthEmail(uid) : null;

    const mpPayer = isPix
      ? { entity_type: "individual", email: emailToSend }
      : {
          email: emailToSend,
          identification: (isCard || isBoleto) ? { type: idType, number: String(idNumber) } : undefined,
          first_name: firstName || fullName || "Cliente",
          last_name:  lastName  || (fullName ? "" : "CCBMG")
        };

    // (NOVO) external_reference: preferir uid|invoiceId quando temos invoice do front/servidor
    const externalRef = invId ? `${uid}|${invId}` : (invDocRef?.id || undefined);

    // Monta o pagamento conforme método
    const body = {
      transaction_amount: amount,
      description: `Associação ${PLAN_LABEL[planType]}`,
      payment_method_id,                 // "master" | "pix" | "bolbradesco" ...
      installments: Number(installments || 1),
      external_reference: externalRef,
      statement_descriptor: "CLUBE CAVALO",
      binary_mode: true,
      metadata: { uid, planType, invoiceId: invId, source: "brick" },
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
      await invDocRef.set({
        status: "erro",
        gatewayError: description,
        gatewayCode: code,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      // Info de ambiente/token para ajudar a diagnosticar "Unauthorized use of live credentials"
      const tokenPrefix = String(process.env.MP_ACCESS_TOKEN || "").slice(0, 12);

      return res.status(500).json({
        error: description,
        code: raw?.status || code || "unknown",
        hint: isPolicy
          ? "Token do servidor parece de PRODUÇÃO. Use o Access Token da tela 'Credenciais de teste' na Vercel."
          : null,
        debug: {
          method: isPix ? "pix" : (isCard ? "card" : (isBoleto ? "boleto" : "other")),
          sentEmail: emailToSend ? emailToSend : "(omitted)",
          payment_method_id,
          payment_type_id,
          hasToken: !!token,
          envMode: isTestEnv ? "TEST" : "PROD",
          envToken: tokenPrefix // só prefixo para segurança
        }
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
    await invDocRef.set(patch, { merge:true });

    // ===== Atualiza summary (próximo vencimento)
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);

    const summaryRef = db.collection("users").doc(uid).collection("finance").doc("summary");
    await summaryRef.set({
      planType,
      lastPayment: approved ? (patch.paidAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
      lastAmount: amount,
      nextDue: Timestamp.fromDate(end),
      updatedAt: FieldValue.serverTimestamp(),
      ...(approved ? { balance: 0, activeUntil: Timestamp.fromDate(end), exempt: false } : {})
    }, { merge:true });

    // Se aprovado, garante perfil ativo e status "Em dia"
    if (approved) {
      const userRef = db.collection("users").doc(uid);
      await userRef.set({
        ativo: true,
        status: "Em dia",
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

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
          poi?.qr_code ||
          null;

        const link = td?.external_resource_url || poi?.ticket_url || null;

        next_action = { type: "boleto", barcode, link };
      }
    }

    return res.status(200).json({
      id: pay.id,
      status: pay.status,
      status_detail: pay.status_detail,
      invoice_id: invId,
      next_action
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
}
