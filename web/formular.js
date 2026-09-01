/* Formuláře – společné pro všechny stránky.

   Celá stránka je jeden formulář, přesně jako u Konverzek: pole se skládají
   volně po stránce a odesílací tlačítko sebere všechna pole na stránce, ať
   leží v hotovém formuláři, nebo si je někdo poskládal sám. */

const NK_FORMULARE = "form.nk-stranka-form, form.nk-form, form#lead";
const NK_EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]{2,})+$/;

/* Pole schovaná v neaktivním kroku nebo v zavřeném vyskakovacím okně se
   neposílají ani nevalidují – zákazník je nikdy neviděl. */
function nkPole(koren, iSkryte) {
  return [...koren.querySelectorAll("input, select, textarea")].filter((el) => {
    if (!el.name || el.disabled) return false;
    if (el.type === "hidden") return !!iSkryte;
    return !el.closest("[hidden]");
  });
}

function nkObalPole(el) {
  return el.closest(".nk-pole") || el.closest(".nk-produkt") || el.parentElement;
}

/* Hláška patří k poli, ne nahoru nad formulář – návštěvník musí hned vidět,
   které pole má opravit. */
function nkChyba(el, text) {
  const obal = nkObalPole(el);
  if (!obal) return;
  obal.classList.toggle("nk-pole-spatne", !!text);
  let misto = obal.querySelector("[data-chyba]");
  if (!misto && text) {
    misto = document.createElement("p");
    misto.className = "nk-pole-chyba";
    misto.setAttribute("data-chyba", "");
    obal.appendChild(misto);
  }
  if (misto) misto.textContent = text || "";
}

function nkCifry(text) {
  return String(text || "").replace(/\D+/g, "");
}

/* Kontrola jednoho pole. Vrací text chyby, nebo prázdno, když je pole v pořádku. */
function nkOverPole(el) {
  const typ = el.getAttribute("input-type") || el.type;
  const hodnota = String(el.value == null ? "" : el.value).trim();

  if (el.type === "checkbox") {
    return el.required && !el.checked ? "Bez zaškrtnutí to dál nepůjde." : "";
  }
  if (el.required && !hodnota) return "Tohle pole prosím vyplňte.";
  if (!hodnota) return "";

  if (typ === "email" && !NK_EMAIL.test(hodnota)) {
    return "E-mail nevypadá správně, zkontrolujte ho.";
  }
  if (typ === "phone" || typ === "phone-with-preselection") {
    const cislic = nkCifry(hodnota).length;
    if (cislic < 9 || cislic > 15) return "Telefon zadejte i s předvolbou.";
  }
  if (typ === "postal-code" && nkCifry(hodnota).length !== 5) {
    return "PSČ má 5 číslic.";
  }
  if (typ === "taxNumber" && nkCifry(hodnota).length < 8) {
    return "IČO má 8 číslic.";
  }
  if (el.type === "number") {
    const cislo = Number(hodnota.replace(",", "."));
    if (isNaN(cislo)) return "Zadejte prosím číslo.";
    if (el.min !== "" && cislo < Number(el.min)) return "Nejméně " + el.min + ".";
    if (el.max !== "" && cislo > Number(el.max)) return "Nejvíce " + el.max + ".";
  }
  if (el.type === "date" || el.type === "datetime-local" || el.type === "time") {
    if (el.min && hodnota < el.min) return "Dřívější termín bohužel nejde.";
    if (el.max && hodnota > el.max) return "Pozdější termín bohužel nejde.";
  }
  return "";
}

/* Projde všechna viditelná pole v oblasti a vrátí to první chybné. */
function nkZkontroluj(koren) {
  const pole = nkPole(koren, false);
  const hotoveSkupiny = {};
  let prvni = null;

  pole.forEach((el) => {
    if (el.type === "radio") {
      if (hotoveSkupiny[el.name]) return;
      hotoveSkupiny[el.name] = true;
      const skupina = pole.filter((x) => x.type === "radio" && x.name === el.name);
      const povinna = skupina.some((x) => x.required);
      const vybrano = skupina.some((x) => x.checked);
      const text = povinna && !vybrano ? "Zvolte jednu z možností." : "";
      nkChyba(el, text);
      if (text && !prvni) prvni = el;
      return;
    }
    const text = nkOverPole(el);
    nkChyba(el, text);
    if (text && !prvni) prvni = el;
  });

  if (prvni) {
    prvni.focus({ preventScroll: true });
    const obal = nkObalPole(prvni) || prvni;
    if (obal.scrollIntoView) obal.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return !prvni;
}

/* Sběr hodnot. Víc polí se stejným jménem (zaškrtávátka, produkty) se spojí
   čárkou, ať se v přijatém leadu nic neztratí. */
function nkSberPoli(koren) {
  const data = {};
  nkPole(koren, true).forEach((el) => {
    if ((el.type === "checkbox" || el.type === "radio") && !el.checked) return;
    const hodnota = String(el.value == null ? "" : el.value).trim();
    /* hasOwnProperty, ne „in" – pole pojmenované třeba „constructor" by
       jinak zdědilo hodnotu z prototypu a slepilo se s ní. */
    data[el.name] = Object.prototype.hasOwnProperty.call(data, el.name)
      ? data[el.name] + ", " + hodnota : hodnota;
  });

  /* Jméno a příjmení zvlášť server nezná – složíme mu je do jednoho pole. */
  if (!data.name && (data.fname || data.lname)) {
    data.name = [data.fname, data.lname].filter(Boolean).join(" ");
  }
  /* Předvolba je vlastní rozbalovátko, do telefonu ji musíme dolepit sami. */
  if (data.phone && data.phone_predvolba && data.phone.charAt(0) !== "+") {
    data.phone = data.phone_predvolba + " " + data.phone;
  }
  delete data.phone_predvolba;
  return data;
}

/* Blok, ke kterému odesílací tlačítko patří – z něj se bere typ konverze,
   tlačítko a místo na hlášku. Na stránce jich může být víc. */
function nkBlok(form, spoustec) {
  const okoli = spoustec && spoustec.closest(".nk-form-obal, .nk-form, .nk-krok");
  return okoli || form.querySelector(".nk-form-obal, .nk-form") || form;
}

/* Odesílá-li odkaz s akcí „odeslat", prohlížeč žádného submittera nehlásí.
   Poslední kliknutý spouštěč si proto pamatujeme sami. */
let nkSpoustec = null;

/* Volně poskládaná pole nemusí mít v okolí odstavec na hlášku – doplníme ho
   za tlačítko, jinak by odpověď serveru neměla kde vyjít. */
function nkMistoNaHlasku(blok, form, spoustec) {
  const nalezena = blok.querySelector(".nk-hlaska") || form.querySelector(".nk-hlaska")
    || document.getElementById("hlaska");
  if (nalezena || !spoustec || !spoustec.parentElement) return nalezena;
  const nova = document.createElement("p");
  nova.className = "nk-hlaska";
  nova.setAttribute("role", "status");
  nova.setAttribute("aria-live", "polite");
  spoustec.parentElement.insertBefore(nova, spoustec.nextSibling);
  return nova;
}

document.querySelectorAll(NK_FORMULARE).forEach((form) => {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const spoustec = e.submitter || nkSpoustec;
    nkSpoustec = null;
    const blok = nkBlok(form, spoustec);
    const hlaska = nkMistoNaHlasku(blok, form, spoustec);
    const tlacitko = spoustec && spoustec.tagName === "BUTTON"
      ? spoustec : blok.querySelector("button[type=submit]");
    if (hlaska) { hlaska.textContent = ""; hlaska.className = "nk-hlaska"; }

    /* Validujeme celý formulář, ne jen blok tlačítka – odesílá se všechno. */
    if (!nkZkontroluj(form)) return;

    const puvodni = tlacitko ? tlacitko.textContent : "";
    if (tlacitko) { tlacitko.disabled = true; tlacitko.textContent = "Odesílám…"; }

    const data = nkSberPoli(form);
    Object.assign(data, window.NK || {});
    data.stranka = (window.NK || {}).varianta;
    const nositel = (spoustec && spoustec.closest("[data-typ]"))
      || form.querySelector("[data-typ]") || form;
    data.typ = nositel.dataset.typ || "poptavka";
    data.utm = location.search.replace(/^\?/, "");

    try {
      const r = await fetch((window.NK_ZAKLAD || "") + "/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const o = await r.json();
      if (!o.ok) throw new Error(o.chyba || "Odeslání se nepovedlo.");
      if (o.dekovacka) { location.href = (window.NK_ZAKLAD || "") + o.dekovacka; return; }
      /* Bez děkovací stránky poděkujeme na místě. Přepsat smíme jen blok
         formuláře – celá stránka je taky formulář a ta musí zůstat stát. */
      if (blok !== form) {
        blok.innerHTML = '<p class="nk-form-hotovo"><strong>Máme to.</strong> Ozveme se.</p>';
      } else {
        if (hlaska) { hlaska.textContent = "Máme to. Ozveme se."; hlaska.className = "nk-hlaska uspech"; }
        nkPole(form, false).forEach((el) => { el.disabled = true; });
        if (tlacitko) { tlacitko.disabled = true; tlacitko.textContent = "Odesláno"; }
      }
    } catch (err) {
      if (hlaska) { hlaska.textContent = err.message; hlaska.className = "nk-hlaska chyba"; }
      if (tlacitko) { tlacitko.disabled = false; tlacitko.textContent = puvodni; }
    }
  });

  /* Jakmile člověk pole opraví, hláška u něj musí zmizet. */
  form.addEventListener("input", (e) => {
    if (e.target.name) nkChyba(e.target, "");
  });
  form.addEventListener("change", (e) => {
    if (e.target.name) nkChyba(e.target, "");
  });
});

/* --------------------------------------------------- kroky formuláře */

/* Dvoukrokový formulář. Neaktivní krok je schovaný, takže se z něj pole ani
   neposílají – server dostane jen to, co zákazník opravdu vyplnil. */
(function () {
  const kroky = [...document.querySelectorAll("[data-kroky]")];
  if (!kroky.length) return;

  const prepni = (obal, cislo) => {
    obal.querySelectorAll("[data-krok]").forEach((k) => {
      k.hidden = k.dataset.krok !== cislo;
    });
    obal.querySelectorAll(".nk-krok-tab").forEach((t) => {
      t.classList.toggle("nk-krok-tab-aktivni", t.dataset.tab === cislo);
    });
    obal.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  document.addEventListener("click", (e) => {
    const dal = e.target.closest('[data-akce="dalsi-krok"]');
    if (dal) {
      const obal = dal.closest("[data-kroky]");
      const krok = dal.closest("[data-krok]");
      if (!obal || !krok) return;
      e.preventDefault();
      /* Do dalšího kroku pustíme jen vyplněný krok – jinak by zákazník
         vyplňoval platbu a teprve pak se dozvěděl, že mu chybí adresa. */
      if (!nkZkontroluj(krok)) return;
      prepni(obal, "2");
      return;
    }

    const zpet = e.target.closest("[data-zpet-na-krok]");
    if (zpet) {
      const obal = zpet.closest("[data-kroky]");
      if (!obal) return;
      e.preventDefault();
      prepni(obal, zpet.dataset.zpetNaKrok || "1");
      return;
    }

    const tab = e.target.closest(".nk-krok-tab");
    if (tab) {
      const obal = tab.closest("[data-kroky]");
      if (!obal) return;
      e.preventDefault();
      const cil = tab.dataset.tab || "1";
      const prvni = obal.querySelector('[data-krok="1"]');
      if (cil === "2" && prvni && !nkZkontroluj(prvni)) return;
      prepni(obal, cil);
    }
  });
})();

/* ------------------------------------------------- produkty a souhrn */

/* Souhrn objednávky se počítá v prohlížeči: zákazník musí vidět cenu hned,
   jak přidá kus nebo zaškrtne nabídku navíc. */
(function () {
  const souhrny = [...document.querySelectorAll("[data-souhrn]")];
  if (!souhrny.length) return;

  const oblastSouhrnu = (s) => s.closest(".nk-krok") || s.closest(".nk-form-obal") || document;

  const prepocitej = () => {
    souhrny.forEach((souhrn) => {
      const oblast = oblastSouhrnu(souhrn);
      let celkem = 0;
      oblast.querySelectorAll("[data-produkt]").forEach((radek) => {
        const volba = radek.querySelector('input[type=radio], input[type=checkbox]');
        if (volba && !volba.checked) return;
        const pocet = Number((radek.querySelector(".nk-mnozstvi-pole") || {}).value) || 1;
        celkem += (Number(radek.dataset.cena) || 0) * pocet;
      });
      const mena = souhrn.dataset.mena || "Kč";
      const text = celkem.toLocaleString("cs-CZ") + (mena ? " " + mena : "");
      souhrn.querySelectorAll("[data-souhrn-mezisoucet], [data-souhrn-celkem]")
        .forEach((b) => { b.textContent = text; });
      const skryte = souhrn.querySelector('input[name="celkem"]');
      if (skryte) skryte.value = String(celkem);
    });
  };

  document.addEventListener("click", (e) => {
    const krok = e.target.closest("[data-mnozstvi]");
    if (!krok) return;
    e.preventDefault();
    const pole = krok.parentElement.querySelector(".nk-mnozstvi-pole");
    if (!pole) return;
    const nova = (Number(pole.value) || 1) + Number(krok.dataset.mnozstvi);
    pole.value = String(Math.max(Number(pole.min) || 1, Math.min(Number(pole.max) || 999, nova)));
    prepocitej();
  });
  document.addEventListener("change", prepocitej);
  document.addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("nk-mnozstvi-pole")) prepocitej();
  });
  prepocitej();
})();

/* ------------------------------------------------------ meze datumu */

/* Hranice „dnes" nemůže dosadit server: publikovaná stránka je statický
   soubor, který visí klidně měsíce. Počítá se proto až tady. */
(function () {
  const pole = [...document.querySelectorAll("[data-min-typ], [data-max-typ]")];
  if (!pole.length) return;

  const naText = (datum, sCasem) => {
    const dvoj = (c) => (c < 10 ? "0" : "") + c;
    const den = datum.getFullYear() + "-" + dvoj(datum.getMonth() + 1) + "-" + dvoj(datum.getDate());
    return sCasem ? den + "T" + dvoj(datum.getHours()) + ":" + dvoj(datum.getMinutes()) : den;
  };

  pole.forEach((el) => {
    const sCasem = el.type === "datetime-local";
    /* Meze dávají smysl jen u data – u samotného času by z nich vyšel nesmysl. */
    if (!sCasem && el.type !== "date") return;
    ["min", "max"].forEach((strana) => {
      const typ = el.dataset[strana + "Typ"];
      if (!typ) return;
      if (typ === "datum") {
        if (el.dataset[strana + "Datum"]) el[strana] = el.dataset[strana + "Datum"];
        return;
      }
      const posun = typ === "posun" ? Number(el.dataset[strana + "Posun"]) || 0 : 0;
      const d = new Date();
      d.setDate(d.getDate() + posun);
      if (!sCasem) { d.setHours(0, 0, 0, 0); }
      el[strana] = naText(d, sCasem);
    });
  });
})();

/* ------------------------------------------------------------- vyskakovací okna */

/* Okno se otevře odkazem #id, po čase, nebo když myš míří pryč ze stránky.
   Jednou zavřené okno se v té návštěvě samo neotevře podruhé. */
(function () {
  const okna = [...document.querySelectorAll(".nk-popup[data-spoustec]")];
  if (!okna.length) return;

  const otevri = (o) => {
    if (o.dataset.uzavreno === "1") return;
    o.hidden = false;
    document.body.style.overflow = "hidden";
  };
  const zavri = (o) => {
    o.hidden = true;
    o.dataset.uzavreno = "1";
    document.body.style.overflow = "";
  };

  document.addEventListener("click", (e) => {
    const zav = e.target.closest("[data-zavri-popup]");
    if (zav) return zavri(zav.closest(".nk-popup"));
    const odkaz = e.target.closest('a[href^="#"]');
    if (!odkaz) return;
    const cil = document.getElementById(odkaz.getAttribute("href").slice(1));
    if (cil && cil.classList.contains("nk-popup")) {
      e.preventDefault();
      cil.dataset.uzavreno = "";
      otevri(cil);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    okna.filter((o) => !o.hidden).forEach(zavri);
  });

  okna.forEach((o) => {
    if (o.dataset.spoustec === "cas") {
      setTimeout(() => otevri(o), Math.max(Number(o.dataset.zpozdeni) || 5, 1) * 1000);
    }
    if (o.dataset.spoustec === "odchod") {
      document.addEventListener("mouseout", (e) => {
        if (!e.relatedTarget && e.clientY <= 0) otevri(o);
      });
    }
  });
})();

/* ------------------------------------------------------------------ proměnné */

/* Personalizace z adresy: ?jmeno=Ivana doplní {{jmeno}} v textech. Stránka
   je statická, takže dosazení musí proběhnout tady. */
(function () {
  const mista = document.querySelectorAll(".nk-prom[data-prom]");
  if (!mista.length) return;
  const parametry = new URLSearchParams(location.search);
  mista.forEach((m) => {
    const hodnota = parametry.get(m.dataset.prom);
    if (hodnota !== null) m.textContent = hodnota.slice(0, 80);
  });
})();

/* ------------------------------------------------------------------ odpočty */

/* Server vykreslil hodnoty k okamžiku renderu, prohlížeč je dopočítává. Jeden
   interval obslouží všechny odpočty na stránce. Skript se načítá jen na živé
   stránce, takže v editoru čas stojí – plátno má ukazovat statický stav. */
(function () {
  const uzly = [...document.querySelectorAll(".nk-odpocet")];
  if (!uzly.length) return;

  const DEN = 86400000;

  const cookie = (jmeno) => {
    const m = document.cookie.match("(?:^|; )" + jmeno + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : "";
  };
  const ulozCookie = (jmeno, hodnota, dni) =>
    (document.cookie = jmeno + "=" + encodeURIComponent(hodnota)
      + ";expires=" + new Date(Date.now() + dni * DEN).toUTCString()
      + ";path=/;SameSite=Lax");

  /* Kdy odpočet skončí. Evergreen si konec pamatuje v cookie, jinak by se
     každým načtením stránky rozběhl znovu od začátku. */
  function konecOdpoctu(el, znovu) {
    const typ = el.dataset.typ || "do-data";
    if (typ === "do-casu") {
      const s = Number(el.dataset.cas) || 0;
      const d = new Date();
      const dnes = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + s * 1000;
      return dnes > Date.now() ? dnes : dnes + DEN;
    }
    if (typ === "evergreen") {
      const trvani = (Number(el.dataset.trvani) || 0) * 1000;
      const ident = el.dataset.cookieIdent;
      if (!ident) return Date.now() + trvani;
      const ulozeny = Number(cookie("nkod_" + ident));
      if (!znovu && ulozeny > 0) return ulozeny;
      const konec = Date.now() + trvani;
      ulozCookie("nkod_" + ident, String(konec), 365);
      return konec;
    }
    return Date.parse(el.dataset.doKdy || "");
  }

  const konce = new Map();
  uzly.forEach((el) => konce.set(el, konecOdpoctu(el, false)));

  function dobehlo(el) {
    if (el.dataset.hotovo === "1") return;
    el.dataset.hotovo = "1";
    const co = el.dataset.poKonci || "nic";
    if (co === "restart") {
      konce.set(el, konecOdpoctu(el, true));
      el.dataset.hotovo = "";
      return;
    }
    if (co === "presmerovat" && el.dataset.presmerovat) {
      location.href = el.dataset.presmerovat;
      return;
    }
    if (co === "odemknout") {
      /* Cíl schoval stylopis vedle odpočtu – stačí ho zahodit a prvek se
         vrátí ke svému původnímu display, ať je to blok, nebo inline. */
      const styl = el.querySelector("style[data-odemknout]");
      if (styl) styl.remove();
      const cil = el.dataset.odemknout && document.getElementById(el.dataset.odemknout);
      if (cil) cil.hidden = false;
    }
  }

  function tik() {
    const ted = Date.now();
    uzly.forEach((el) => {
      const konec = konce.get(el);
      if (!konec || isNaN(konec)) return;
      const zbyva = Math.max(0, Math.floor((konec - ted) / 1000));
      const casti = {
        dny: Math.floor(zbyva / 86400),
        hodiny: Math.floor((zbyva % 86400) / 3600),
        minuty: Math.floor((zbyva % 3600) / 60),
        sekundy: zbyva % 60,
      };
      for (const klic in casti) {
        const b = el.querySelector('[data-jednotka="' + klic + '"] b');
        /* Nula vpředu jen do devítky – dní může být klidně 120 a ty se nesmí useknout. */
        if (b) b.textContent = (casti[klic] < 10 ? "0" : "") + casti[klic];
      }
      el.classList.toggle("nk-odpocet-konec", zbyva === 0);
      if (zbyva === 0) dobehlo(el);
    });
  }

  tik();
  setInterval(tik, 1000);
})();

/* ------------------------------------------------------- odložené tlačítko */

/* Tlačítko se objeví až po nastavené době. Klíčové pro VSL a webináře:
   nabídka nesmí být vidět dřív, než ji video vysvětlí. */
document.querySelectorAll("[data-zobrazit-po]").forEach((obal) => {
  const sekundy = Number(obal.dataset.zobrazitPo) || 0;
  setTimeout(() => { obal.hidden = false; }, sekundy * 1000);
});

/* --------------------------------------------------------- akce na prvcích */

document.addEventListener("click", (e) => {
  /* Tlačítko, které jen odešle nejbližší formulář. */
  const odeslat = e.target.closest('[data-akce="odeslat"]');
  if (odeslat) {
    nkSpoustec = odeslat;
    const form = odeslat.closest("form")
      || document.querySelector(NK_FORMULARE);
    if (form) {
      e.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
    return;
  }

  /* Zavírací křížek upozornění. Mažeme celý prvek – samotné hidden by na
     .nk-upozorneni neplatilo, to je flex. */
  const zavri = e.target.closest("[data-zavri-upozorneni]");
  if (zavri) {
    const box = zavri.closest(".nk-upozorneni");
    if (box) box.remove();
    return;
  }

  /* Slevový kód se posílá spolu s leadem, proto se ukládá do skrytého pole
     formuláře – ne do vlastního requestu. */
  const kupon = e.target.closest('[data-akce="vlozit-slevovy-kod"]');
  if (kupon) {
    const obal = kupon.closest(".nk-slevovy-kod");
    const pole = obal && obal.querySelector(".nk-slevovy-kod-pole");
    const kod = pole ? pole.value.trim() : "";
    if (!kod) return;
    const form = (obal && obal.closest("form")) || document.querySelector(NK_FORMULARE);
    if (form) {
      let skryte = form.querySelector('input[name="slevovy_kod"]');
      if (!skryte) {
        skryte = document.createElement("input");
        skryte.type = "hidden";
        skryte.name = "slevovy_kod";
        form.appendChild(skryte);
      }
      skryte.value = kod;
    }
    const hlaska = obal && obal.querySelector(".nk-slevovy-kod-hlaska");
    if (hlaska) hlaska.textContent = kupon.dataset.hlaska || "";
  }
});

/* --------------------------------------------------------- náhled obrázku */

/* Lupa nad obrázkem. Vrstva vzniká až po kliknutí, aby stránka nenesla
   prázdný modal, který nikdo neotevře. */
(function () {
  const spouste = [...document.querySelectorAll("a[data-nahled]")];
  if (!spouste.length) return;
  let vrstva = null;

  const zavri = () => {
    if (!vrstva) return;
    vrstva.remove();
    vrstva = null;
    document.body.style.overflow = "";
  };

  spouste.forEach((a) => a.addEventListener("click", (e) => {
    const obrazek = a.querySelector("img");
    if (!obrazek) return;
    e.preventDefault();
    zavri();
    vrstva = document.createElement("div");
    vrstva.className = "nk-nahled";
    const velky = document.createElement("img");
    velky.src = obrazek.currentSrc || obrazek.src;
    velky.alt = obrazek.alt || "";
    vrstva.appendChild(velky);
    vrstva.addEventListener("click", zavri);
    document.body.appendChild(vrstva);
    document.body.style.overflow = "hidden";
  }));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") zavri();
  });
})();

/* ----------------------------------------------------- menu členské sekce */

/* Přihlášení a odhlášení jsou v HTML obě, ať jdou v editoru nastylovat.
   Tady se podle cookie schová ta nesprávná.

   Čte se stavová cookie nk_clen_stav_<projekt>, ne ta podepsaná – ta je
   HttpOnly (jinak by ji cizí skript odnesl i s přístupem) a skript na ni
   nedosáhne. Stavová cookie sama nic neodemyká, jen přepíná menu; o tom,
   co se ukáže za obsah, rozhoduje dál server podle podepsané cookie. */
(function () {
  const menu = [...document.querySelectorAll(".nk-menu-clenska")];
  if (!menu.length) return;
  const projekt = (window.NK && window.NK.projekt) || "";
  const prihlasen = document.cookie.split(";").some((kus) => {
    const jmeno = kus.split("=")[0].trim();
    // Bez znalosti projektu (náhled, cizí vložení) bere první členskou cookie.
    return projekt ? jmeno === "nk_clen_stav_" + projekt
                   : jmeno.indexOf("nk_clen_stav_") === 0;
  });
  const schovej = prihlasen ? "prihlaseni" : "odhlaseni";
  const ukaz = prihlasen ? "odhlaseni" : "prihlaseni";
  menu.forEach((m) => {
    m.querySelectorAll('[data-clen="' + schovej + '"]').forEach((x) => (x.hidden = true));
    m.querySelectorAll('[data-clen="' + ukaz + '"]').forEach((x) => (x.hidden = false));
  });
})();

/* ------------------------------------------------------ sdílení na Facebook */

/* Nevyplněný odkaz znamená „tuhle stránku". Adresu zná až prohlížeč – stránka
   se servíruje jako statický soubor, server ji nedoplní. */
document.querySelectorAll("a[data-sdilet]").forEach((a) => {
  try {
    const adresa = new URL(a.href, location.href);
    if (!adresa.searchParams.get("u")) {
      adresa.searchParams.set("u", location.href);
      a.href = adresa.toString();
    }
  } catch (err) { /* rozbitá adresa se prostě nechá být */ }
});

/* ------------------------------------------------------------------- dotazník */

/* Dotazník krokuje po otázkách. Renderer vysází všechny kroky do stránky a
   pošle logiku v data-dotaznik-config; tenhle skript kroky přepíná, hlídá
   povinné odpovědi a na konci složí výsledek do skrytého pole. Do stránky
   nic nevypisuje – z konfigurace čte jen klíče a akce. */
(function () {
  document.querySelectorAll(".nk-dotaznik[data-dotaznik]").forEach(nastav);

  function nastav(dotaznik) {
    let cfg;
    try {
      cfg = JSON.parse(dotaznik.dataset.dotaznikConfig || "{}");
    } catch (e) {
      return;
    }
    const kroky = [...dotaznik.querySelectorAll("[data-krok]")];
    if (!kroky.length) return;

    const vysledky = dotaznik.querySelector("[data-dotaznik-vysledky]");
    const nacitani = dotaznik.querySelector("[data-nacitani]");
    const zpet = dotaznik.querySelector('[data-akce="predchozi-otazka"]');
    const nekoncovy = dotaznik.querySelector(".nk-dotaznik-nekoncovy");
    const koncovy = dotaznik.querySelector(".nk-dotaznik-koncovy");
    const postupVypln = dotaznik.querySelector("[data-postup-vypln]");
    const postupCislo = dotaznik.querySelector("[data-postup-cislo]");
    const historie = [];
    let ted = 0;

    const definice = (i) => (cfg.kroky || [])[i] || {};

    function ukaz(i) {
      ted = i;
      kroky.forEach((k, n) => { k.hidden = n !== i; });
      if (zpet) zpet.hidden = historie.length === 0;
      const posledni = i === kroky.length - 1;
      if (nekoncovy) nekoncovy.hidden = posledni;
      if (koncovy) koncovy.hidden = !posledni;
      if (postupVypln) postupVypln.style.width = ((i + 1) / kroky.length) * 100 + "%";
      if (postupCislo) postupCislo.textContent = (i + 1) + "/" + kroky.length;
      schovejChybu(kroky[i]);
    }

    function schovejChybu(krok) {
      const ch = krok && krok.querySelector("[data-chyba]");
      if (ch) ch.hidden = true;
    }

    function odpovediKroku(krok) {
      return [...krok.querySelectorAll(".nk-dotaznik-volba")].filter((v) => v.checked);
    }

    function vyplneno(krok) {
      if (!krok.hasAttribute("data-povinne")) return true;
      if (krok.dataset.typ === "otazka") return odpovediKroku(krok).length > 0;
      const pole = [...krok.querySelectorAll("input, textarea, select")]
        .filter((x) => !x.disabled && x.type !== "hidden");
      return pole.every((x) => String(x.value || "").trim() !== "");
    }

    /* Kam se jde z právě zodpovězeného kroku. Akce nese odpověď, jinak
       pokračujeme na následující krok. */
    function dalsiIndex(krok) {
      const vybrane = odpovediKroku(krok);
      const akce = vybrane.length === 1 ? vybrane[0].dataset.akce : "";
      const cil = vybrane.length === 1 ? vybrane[0].dataset.cil : "";
      if (akce === "konec-dotazniku") return kroky.length - 1;
      if (akce === "skok-na-otazku" && cil) {
        const i = kroky.findIndex((k) => k.dataset.klic === cil);
        if (i >= 0) return i;
      }
      return Math.min(ted + 1, kroky.length - 1);
    }

    function dopredu() {
      const krok = kroky[ted];
      if (!vyplneno(krok)) {
        const ch = krok.querySelector("[data-chyba]");
        if (ch) ch.hidden = false;
        return;
      }
      const cil = dalsiIndex(krok);
      if (cil === ted) return dokonci();
      historie.push(ted);
      ukaz(cil);
    }

    function dozadu() {
      if (!historie.length) return;
      ukaz(historie.pop());
    }

    function sesbirej() {
      const out = {};
      kroky.forEach((krok) => {
        const klic = krok.dataset.klic;
        if (krok.dataset.typ === "otazka") {
          const v = odpovediKroku(krok).map((x) => x.value);
          if (v.length) out[klic] = v.length === 1 ? v[0] : v;
        } else {
          const pole = [...krok.querySelectorAll("input, textarea, select")]
            .filter((x) => x.name && x.type !== "hidden" && String(x.value || "").trim());
          pole.forEach((x) => { out[x.name] = x.value; });
        }
      });
      return out;
    }

    function dokonci() {
      const krok = kroky[ted];
      if (!vyplneno(krok)) {
        const ch = krok.querySelector("[data-chyba]");
        if (ch) ch.hidden = false;
        return;
      }
      if (vysledky) vysledky.value = JSON.stringify(sesbirej());
      if (cfg.vysledek === "nacitani-a-odeslat" && nacitani) return sPrestavkou();
      odesli();
    }

    /* Mezikrok „vyhodnocujeme odpovědi" – čistě vizuální, ale reference ho má,
       protože bez něj působí okamžité odeslání podezřele. */
    function sPrestavkou() {
      kroky.forEach((k) => { k.hidden = true; });
      const lista = dotaznik.querySelector(".nk-dotaznik-lista");
      if (lista) lista.hidden = true;
      nacitani.hidden = false;
      const vypln = nacitani.querySelector("[data-nacitani-vypln]");
      const trvani = Math.max(Number(nacitani.dataset.trvani) || 2500, 300);
      const start = performance.now();
      (function krok(t) {
        const podil = Math.min((t - start) / trvani, 1);
        if (vypln) vypln.style.width = podil * 100 + "%";
        if (podil < 1) return requestAnimationFrame(krok);
        odesli();
      })(start);
    }

    function odesli() {
      const form = dotaznik.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }

    dotaznik.addEventListener("click", (e) => {
      const b = e.target.closest("[data-akce]");
      if (!b || b.tagName === "INPUT") return;
      const akce = b.dataset.akce;
      if (akce === "pokracovat-dotaznik") { e.preventDefault(); dopredu(); }
      if (akce === "dokoncit-dotaznik") { e.preventDefault(); dokonci(); }
      if (akce === "predchozi-otazka") { e.preventDefault(); dozadu(); }
    });

    /* Volba s vlastní akcí posouvá dotazník rovnou, bez tlačítka – tak to
       dělá i reference u jednovýběrových otázek. */
    dotaznik.addEventListener("change", (e) => {
      const v = e.target.closest(".nk-dotaznik-volba");
      if (!v) return;
      schovejChybu(kroky[ted]);
      const d = definice(ted);
      if (v.type === "radio" && !d.vice) setTimeout(dopredu, 120);
    });

    ukaz(0);
  }
})();
