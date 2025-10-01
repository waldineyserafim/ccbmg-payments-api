// _mp.js
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

// 1) Detecta ambiente de teste
const isTestEnv =
  String(process.env.MP_ENV || "").toUpperCase() === "TEST" ||
  /localhost|127\.0\.0\.1/.test(process.env.VERCEL_URL || "") ||
  String(process.env.VERCEL_ENV || "").toLowerCase() !== "production"; // preview/dev → teste

// 2) Lê tokens (e sanitiza)
const tokenTest = (process.env.MP_ACCESS_TOKEN_TEST || process.env.MP_ACCESS_TOKEN || "").trim();
const tokenLive = (process.env.MP_ACCESS_TOKEN_LIVE || "").trim();

// 3) Seleciona o token certo
const accessToken = (isTestEnv ? tokenTest : tokenLive) || "";
if (!accessToken) {
  console.warn("[MP] Access Token não configurado para", isTestEnv ? "TESTE" : "PRODUÇÃO");
}

// 4) Instancia cliente
export const mpClient = new MercadoPagoConfig({
  accessToken,
  options: { timeout: 15000 }
});

// 5) SDKs
export const mpPreference = new Preference(mpClient);
export const mpPayment    = new Payment(mpClient);

// 6) Logs úteis (apenas no server)
try {
  console.log("[MP] Ambiente:", isTestEnv ? "TESTE" : "PRODUÇÃO", "Token prefix:", accessToken.slice(0, 12));
} catch {}
