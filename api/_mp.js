// _mp.js
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

// Separa tokens por ambiente
const isTestEnv =
  String(process.env.MP_ENV || "").toUpperCase() === "TEST" ||
  /localhost|127\.0\.0\.1/.test(process.env.VERCEL_URL || "");

// Use variáveis diferentes no Vercel (Settings > Environment Variables)
const accessToken = isTestEnv
  ? process.env.MP_ACCESS_TOKEN_TEST   // credencial da aba "Credenciais de teste"
  : process.env.MP_ACCESS_TOKEN_LIVE;  // credencial da aba "Credenciais de produção"

export const mpClient = new MercadoPagoConfig({ accessToken });

export const mpPreference = new Preference(mpClient);
export const mpPayment    = new Payment(mpClient);
