import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPreference } from "../_mp.js";

const PLAN_MONTHS = { mensal:1, trimestral:3, semestral:6 };
const PLAN_LABEL  = { mensal:"Mensal", trimestral:"Trimestral", semestral:"Semestral" };
const PLAN_PRICE  = { mensal:30, trimestral:85, semestral:170 }; // ajuste valores aqui

function addMonthsSafe(d, m){
  const x=new Date(d); const day=x.getDate();
  x.setMonth(x.getMonth()+m);
  if(x.getDate()<day) x.setDate(0);
  return x;
}

export default async function handler(req, res){
  // CORS p/ o seu domínio do site
  const ALLOW_ORIGIN = "https://clubedocavalobonfim.com.br";
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);

  try{
    if (req.method!=="POST") return res.status(405).end();
    const { uid, planType="mensal" } = req.body || {};
    if (!uid || !PLAN_MONTHS[planType]) {
      return res.status(400).json({ error:"Parâmetros inválidos" });
    }

    const amount = PLAN_PRICE[planType];

    // define ciclo
    const start = new Date(); start.setHours(0,0,0,0);
    const end = addMonthsSafe(start, PLAN_MONTHS[planType]);
    const due = end;

    // cria fatura em_aberto em users/{uid}/financeInvoices
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

    // cria preferência (Checkout Pro) — SDK v2
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

    const init_point = pref.init_point || pref.sandbox_init_point;
    await invRef.update({ paymentUrl: init_point, preferenceId: pref.id });

    return res.status(200).json({ init_point, preference_id: pref.id });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

