import { db, Timestamp, FieldValue } from "../_firebase.js";
import { mpPreference } from "../_mp.js";

const PLAN_MONTHS = { mensal:1, trimestral:3, semestral:6 };
const PLAN_LABEL  = { mensal:"Mensal", trimestral:"Trimestral", semestral:"Semestral" };
const PLAN_PRICE  = { mensal:30, trimestral:85, semestral:170 };

function addMonthsSafe(d, m){
  const x=new Date(d); const day=x.getDate();
  x.setMonth(x.getMonth()+m);
  if(x.getDate()<day) x.setDate(0);
  return x;
}

export default async function handler(req, res){
  try{
    const today = new Date(); today.setHours(0,0,0,0);

    const q = await db.collectionGroup("finance")
      .where("nextDue", "<=", Timestamp.fromDate(today)).get();

    const jobs = q.docs.map(async docSnap=>{
      const summary = docSnap.data() || {};
      const uid = docSnap.ref.parent.parent.id;
      const planType = summary.planType || "mensal";

      const openInvs = await db.collection("users").doc(uid)
        .collection("financeInvoices")
        .where("status", "==", "em_aberto")
        .where("dueDate", ">=", Timestamp.fromDate(addMonthsSafe(today,-6)))
        .get();
      if (!openInvs.empty) return;

      const start = summary.nextDue?.toDate ? summary.nextDue.toDate() : new Date(summary.nextDue);
      const end   = addMonthsSafe(start, PLAN_MONTHS[planType]);
      const amount = PLAN_PRICE[planType];

      const invRef = await db.collection("users").doc(uid)
        .collection("financeInvoices").add({
          planType, planName: PLAN_LABEL[planType],
          planStart: Timestamp.fromDate(start),
          planEnd: Timestamp.fromDate(end),
          dueDate: Timestamp.fromDate(end),
          amount: Number(amount),
          status: "em_aberto",
          recordedAt: FieldValue.serverTimestamp()
        });

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
    });

    await Promise.all(jobs);
    return res.status(200).json({ ok:true, processed: jobs.length });
  }catch(e){
    console.error(e);
    return res.status(200).json({ ok:false, error: e.message });
  }
}
