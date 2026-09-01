/*
 * Brána celého webu. Bez hesla se dovnitř nedostane nikdo – kontroluje se
 * na serveru, ne v prohlížeči, takže to nejde obejít vypnutým JavaScriptem
 * ani čtením zdrojáku.
 *
 * Heslo drží proměnná prostředí NK_HESLO. Po zadání se posílá podepsaná
 * cookie na 30 dní, aby se heslo nezadávalo pořád dokola.
 */

const COOKIE = "nk_brana";
const VEREJNA_STATIKA = new Set(["/brand.css", "/formular.js", "/komponenty.css"]);
const PLATNOST = 60 * 60 * 24 * 30;   // 30 dní

async function podpis(hodnota: string, tajemstvi: string): Promise<string> {
  const klic = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(tajemstvi),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", klic, new TextEncoder().encode(hodnota));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prihlasovaciStranka(chyba: boolean): Response {
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NK Nástroje</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap">
<style>
:root{--podklad:#001A16;--cyan:#2EFFFF;--zluta:#F8FF29;--bila:#E5FFFF;
  --seda:#79A6A2;--linka:rgba(46,255,255,.15);--karta:rgba(1,64,64,.34);--cervena:#F04436}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--podklad);
  color:var(--bila);font:400 15px/1.55 "Instrument Sans",system-ui,sans-serif}
form{width:min(360px,90vw);background:var(--karta);border:1px solid var(--linka);
  border-radius:16px;padding:30px 28px}
p.eyebrow{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--cyan);margin:0 0 8px}
h1{font-size:23px;margin:0 0 20px;font-weight:700}
input{width:100%;padding:13px 15px;border-radius:10px;border:1px solid var(--linka);
  background:rgba(0,0,0,.25);color:var(--bila);font:inherit;margin-bottom:14px}
input:focus{outline:2px solid var(--cyan);outline-offset:1px;border-color:transparent}
button{width:100%;padding:13px;border:0;border-radius:10px;background:var(--zluta);
  color:var(--podklad);font:600 15px "Instrument Sans",sans-serif;cursor:pointer}
button:hover{filter:brightness(1.07)}
.chyba{color:var(--cervena);font-size:13.5px;margin:0 0 14px}
</style></head><body>
<form method="POST">
  <p class="eyebrow">Nejlepší Koučka</p>
  <h1>Nástroje</h1>
  ${chyba ? '<p class="chyba">Špatné heslo, zkus to znovu.</p>' : ""}
  <input type="password" name="heslo" placeholder="Heslo" autofocus autocomplete="current-password">
  <button type="submit">Vstoupit</button>
</form></body></html>`;
  return new Response(html, {
    status: chyba ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async (request: Request) => {
  // Publikované stránky funnelů a odesílání formulářů jsou veřejné – heslo
  // na nich by zabilo celý smysl. Rozpracovaný koncept veřejný není.
  const kam = new URL(request.url).pathname;
  if (kam === "/builder/api/lead") return;
  // Statika publikovaných stránek. Za heslem by z funnelu zbyl holý text.
  if (VEREJNA_STATIKA.has(kam) || kam.startsWith("/fonts/")) return;
  if (kam.startsWith("/builder/p/") && !kam.replace(/\/+$/, "").endsWith("/koncept")) return;

  const heslo = Deno.env.get("NK_HESLO");
  if (!heslo) return;                       // bez nastaveného hesla bránu nezavíráme

  const ocekavany = await podpis("ok", heslo);
  const cookie = request.headers.get("cookie") || "";
  if (cookie.split(/;\s*/).includes(`${COOKIE}=${ocekavany}`)) return;

  if (request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("heslo") || "") === heslo) {
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(request.url).pathname,
          "set-cookie": `${COOKIE}=${ocekavany}; Path=/; Max-Age=${PLATNOST}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return prihlasovaciStranka(true);
  }

  return prihlasovaciStranka(false);
};

export const config = { path: "/*" };
