/*
 * Backend stavitele funnelů.
 *
 * Netlify neumí Python, tak ho pustíme přes Pyodide (CPython ve WASM) rovnou
 * ve funkci. Díky tomu běží úplně stejný kód jako lokálně – žádný přepis,
 * žádné dvě verze pravdy, které by se rozešly.
 *
 * Databáze žije v Netlify Blobs: při startu se natáhne do paměti Pyodide,
 * po každém zápisu se uloží zpátky.
 */

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { loadPyodide, type PyodideInterface } from "pyodide";
import fs from "node:fs";
import path from "node:path";

/*
 * Netlify rozbaluje included_files vedle funkce, lokální zkouška je má
 * v kořeni repozitáře. Hledáme proto na obou místech, ať to jede stejně.
 */
function najdi(relativni: string): string {
  const kandidati = [
    path.join(process.cwd(), relativni),
    path.join(import.meta.dirname, relativni),
    path.join(import.meta.dirname, "..", "..", relativni),
  ];
  for (const c of kandidati) if (fs.existsSync(c)) return c;
  throw new Error("Nenašel jsem " + relativni + ", zkoušel jsem: " + kandidati.join(", "));
}

const KORENPY = najdi("nkpy");
// sqlite3 není v Pyodide součástí standardní knihovny, veze se jako balíček.
const SQLITE = najdi("pybalicky/sqlite3-1.0.0-cp313-cp313-pyodide_2025_0_wasm32.whl");
// Moduly se berou z adresáře, ne ze seznamu – jinak by nový soubor tiše chyběl.
const MODULY = fs.readdirSync(KORENPY).filter((f) => f.endsWith(".py"));

let pyodide: PyodideInterface | null = null;
let pripravene: Promise<PyodideInterface> | null = null;

// POST, který jen počítá a nic neukládá – databázi po něm zapisovat netřeba.
const JEN_SPOCITA = new Set(["/api/render", "/api/nahled"]);

/** Zápisové cesty musí po sobě uložit databázi, čtecí ne. */
function meniData(metoda: string, cesta: string): boolean {
  return metoda !== "GET" && !JEN_SPOCITA.has(cesta);
}

/*
 * Databáze žije v Blobs. Když úložiště není k dispozici (lokální zkouška),
 * jede se na balíčkované kopii – čtení funguje, zápis se ohlásí jako chyba,
 * aby se změny neztratily potichu.
 */
async function nactiUlozenou(): Promise<Uint8Array | null> {
  try {
    const buf = await getStore("nk-builder").get("konverzky.db", { type: "arrayBuffer" });
    return buf ? new Uint8Array(buf) : null;
  } catch (e) {
    console.warn("Blobs nedostupné, jede se na balíčkované databázi:", (e as Error).message);
    return null;
  }
}

async function nastartuj(): Promise<PyodideInterface> {
  // Plánované publikování porovnává místní čas. Server jede v UTC, takže by
  // se stránky zveřejňovaly o dvě hodiny později, než si Vojta naklikal.
  process.env.TZ = "Europe/Prague";
  const py = await loadPyodide();
  await py.loadPackage(SQLITE);
  py.FS.mkdir("/app");
  for (const m of MODULY) {
    py.FS.writeFile("/app/" + m, fs.readFileSync(path.join(KORENPY, m)));
  }
  for (const slozka of ["sablony", "sekce"]) {
    py.FS.mkdir("/app/" + slozka);
    const dir = path.join(KORENPY, slozka);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      py.FS.writeFile(`/app/${slozka}/${f}`, fs.readFileSync(path.join(dir, f)));
    }
  }
  py.FS.mkdir("/app/projekty");

  // Databáze: co je v Blobs, jinak výchozí z balíčku.
  const ulozena = await nactiUlozenou();
  const db = ulozena ?? new Uint8Array(fs.readFileSync(path.join(KORENPY, "vychozi.db")));
  py.FS.writeFile("/app/konverzky.db", db);

  await py.runPythonAsync(`
import sys, json, sqlite3, contextlib, datetime
sys.path.insert(0, "/app")
from pathlib import Path
from admin_api import AdminApi
import migrace, web_api

@contextlib.contextmanager
def spoj():
    c = sqlite3.connect("/app/konverzky.db")
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()

# Databáze z Blobs může být starší než kód, tak ji vždycky dožene.
_c = sqlite3.connect("/app/konverzky.db")
migrace.spust(_c, Path("/app/konverzky.db"))
_c.close()

def _ted():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")

API = AdminApi(spoj, Path("/app/projekty"), Path("/app/sablony"), _ted, Path("/app/sekce"))

def obsluz(metoda, cesta, dotaz_json, telo_json):
    dotaz = json.loads(dotaz_json or "{}")
    telo = json.loads(telo_json or "{}")
    try:
        kod, data = web_api.smeruj(API, metoda, cesta, dotaz, telo)
    except Exception as e:
        return json.dumps({"__kod": 500, "chyba": "%s: %s" % (type(e).__name__, e)})
    out = data if isinstance(data, dict) else {"data": data}
    out["__kod"] = kod
    return json.dumps(out, ensure_ascii=False)
`);
  return py;
}

async function ziskej(): Promise<PyodideInterface> {
  if (pyodide) return pyodide;
  if (!pripravene) pripravene = nastartuj().then((p) => (pyodide = p));
  return pripravene;
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const cesta = url.pathname.replace(/^\/builder/, "") || "/";
  if (!cesta.startsWith("/api/") && !cesta.startsWith("/p/")) {
    return new Response("Nenalezeno", { status: 404 });
  }

  let telo = "{}";
  if (request.method !== "GET") {
    telo = (await request.text()) || "{}";
  }
  const dotaz = JSON.stringify(Object.fromEntries(url.searchParams));

  const py = await ziskej();
  const obsluz = py.globals.get("obsluz");
  const syrove = obsluz(request.method, cesta, dotaz, telo) as string;
  const data = JSON.parse(syrove);
  const kod = data.__kod ?? 200;
  delete data.__kod;

  // Zápis musí přežít konec funkce, jinak by se změny ztratily.
  if (meniData(request.method, cesta) && kod < 400) {
    try {
      const db = py.FS.readFile("/app/konverzky.db");
      await getStore("nk-builder").set("konverzky.db", db as Uint8Array);
    } catch (e) {
      return new Response(JSON.stringify({
        chyba: "Změnu se nepodařilo uložit: " + (e as Error).message,
      }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  }

  // Vykreslená stránka funnelu se posílá jako HTML, ne jako data.
  if (typeof data.__html === "string") {
    const html = data.__html.replace(
      "</head>", `<script>window.NK_ZAKLAD="/builder";</script></head>`);
    return new Response(html, {
      status: kod,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Rozpracovaná stránka nemá co dělat ve vyhledávačích.
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  return new Response(JSON.stringify(data), {
    status: kod,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { path: ["/builder/api/*", "/builder/p/*"] };
