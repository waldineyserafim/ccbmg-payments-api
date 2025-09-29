import { db, FieldValue, Timestamp } from "../_firebase.js";
import { mpPayment } from "../_mp.js";

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).end();

    const { type, data } = req.body || {};
    if (type !== "payment" || !data?.id) {
      return res.status(200).json({ ok:true, ignored:true });
    }

    const p = await mpPayment.get({ id: data.id });

    const uid = p.metadata?.uid;
    const invoiceId = p.metadata?.invoiceId;
    if (!uid || !invoiceId) {
      return res.status(200).json({ ok:true, ignored:"no metadata" });
    }

    const invRef = db.collection("users").doc(uid)
      .collection("financeInvoices").doc(invoiceId);

    const approved = p.status === "approved";
    const patch = {
      status: approved ? "pago" : p.status,
      method: "MercadoPago",
      gatewayId: String(p.id),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (approved && p.date_approved) {
      patch.paidAt = Timestamp.fromDate(new Date(p.date_approved));
    }

    await invRef.set(patch, { merge:true });

    const invSnap = await invRef.get();
    const inv = invSnap.data() || {};
    const summaryRef = db.collection("users").doc(uid)
      .collection("finance").doc("summary");
    await summaryRef.set({
      planType: inv.planType ?? null,
      lastPayment: inv.paidAt || FieldValue.serverTimestamp(),
      lastAmount: inv.amount ?? null,
      nextDue: inv.planEnd ?? null,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge:true });

    return res.status(200).json({ ok:true });
  }catch(e){
    console.error(e);
    return res.status(200).json({ ok:false, error: e.message });
  }
}
