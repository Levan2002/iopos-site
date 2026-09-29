// Tests for the receipt page (receipt/index.html + receipt.js) in a real DOM (jsdom), with the
// server stubbed. Run from the repository root:
//     deno test --allow-read --allow-env --allow-sys tests/receipt.test.ts
// (with mise: `mise exec deno@latest -- deno test --allow-read --allow-env --allow-sys tests/receipt.test.ts`).

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { JSDOM } from "npm:jsdom@26";

const root = new URL("../receipt/", import.meta.url);
const html = await Deno.readTextFile(new URL("index.html", root));
const script = await Deno.readTextFile(new URL("receipt.js", root));

const api = "https://leneddzaijxgvidtvwid.supabase.co/functions/v1/receipt";
const token = "Q2hlY2tfdGhlX3Rva2VuX2lzXzQzX2NoYXJhY3RlcnM";

function sample(overrides: Record<string, unknown> = {}) {
  return {
    business: {
      name: "Demo Coffee", brand_color: "ocean", address_line1: "1 Main St", address_line2: null, city: "Brooklyn",
      region: "NY", postal_code: "11201", phone: "(555) 555-0100", timezone: "America/Chicago",
    },
    order: {
      number: "A1-0042", status: "partially_refunded", created_at: "2026-09-29T19:30:00.000Z", currency: "USD",
      subtotal_minor: 620, discount_minor: 62, tax_minor: 50, tip_minor: 100, total_minor: 708,
    },
    customer_first_name: "Maria",
    lines: [
      { name: "Latte", variant_name: "Large", quantity: "1.000", modifiers: ["Oat", "Extra shot"], net_minor: 558 },
      { name: "Croissant", variant_name: "Regular", quantity: 2, modifiers: [], net_minor: 0 },
    ],
    discounts: [{ name: "10% off", amount_minor: 62 }],
    payments: [
      { tender: "cash", amount_minor: 408, tip_minor: 58, cash_tendered_minor: 500, change_minor: 92, card_brand: null, card_last4: null },
      { tender: "card_present", amount_minor: 300, tip_minor: 42, cash_tendered_minor: null, change_minor: null, card_brand: "visa", card_last4: "4242" },
    ],
    refunds: [
      { amount_minor: 100, status: "succeeded", created_at: "2026-09-30T15:00:00.000Z" },
      { amount_minor: 50, status: "pending", created_at: "2026-09-30T16:00:00.000Z" },
    ],
    ...overrides,
  };
}

type Answer = { status: number; body?: unknown } | Error;

/** Opens the page at ?t=<t> with fetch answering from `answers`, in order, and runs receipt.js. */
function open(t: string | null, ...answers: Answer[]) {
  return openIn(null, t, ...answers);
}

/**
 * The same, in a browser whose preferred languages are `languages` (navigator.languages, and
 * navigator.language is the first); null keeps jsdom's own ("en-US").
 */
async function openIn(languages: string[] | null, t: string | null, ...answers: Answer[]) {
  const url = "https://levan2002.github.io/iopos-site/receipt/" + (t === null ? "" : `?t=${t}`);
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const window = dom.window;
  if (languages) prefer(window, languages);
  const calls: { url: string; init: RequestInit }[] = [];
  window.fetch = (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    const answer = answers.shift() ?? new Error("no more answers");
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: () => Promise.resolve(answer.body),
    });
  };
  window.eval(script);
  await settle();
  const document = window.document;
  const content = document.getElementById("content")!;
  return { dom, window, document, content, calls, text: () => spaces(content.textContent ?? "") };
}

function prefer(window: { navigator: Navigator }, languages: string[]) {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
  Object.defineProperty(window.navigator, "language", { value: languages[0] ?? "", configurable: true });
}

/** Intl puts no-break spaces in some dates and amounts ("2:30 p.m."); compare them as plain spaces. */
function spaces(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, " ");
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("the receipt shows the business, order, lines, totals, payments and refunds", async () => {
  const page = await open(token, { status: 200, body: sample() });
  assertEquals(page.calls.length, 1);
  assertEquals(page.calls[0].url, `${api}?t=${token}&format=json`);
  assertEquals(page.calls[0].init.credentials, "omit");
  assertEquals(page.calls[0].init.referrerPolicy, "no-referrer");

  assert(page.document.getElementById("loading")!.hidden);
  assertFalse(page.content.hidden);
  const text = page.text();
  for (const expected of [
    "Demo Coffee", "1 Main St", "Brooklyn, NY 11201", "(555) 555-0100",
    "Thanks, Maria!", "$7.08", "Order #A1-0042 · Sep 29, 2026, 2:30 PM CDT", "Partly refunded",
    "1 ×", "Latte (Large)", "Oat, Extra shot", "$5.58", "2 ×",
    "Subtotal$6.20", "10% off−$0.62", "Tax$0.50", "Tip$1.00", "Total$7.08",
    "Cash$5.00", "Change$0.92", "Visa •••• 4242$3.00",
    "Refunded Sep 30, 2026−$1.00", "Refund (processing)−$0.50",
  ]) {
    assertStringIncludes(text, expected);
  }
  assertFalse(text.includes("Croissant (Regular)"));
  assertEquals(page.document.querySelector("header.brand h1")!.textContent, "Demo Coffee");
  assert(page.document.documentElement.classList.contains("brand-ocean"));
  assertEquals(page.document.title, "Receipt from Demo Coffee");
  assertEquals(page.document.documentElement.lang, "en");
  // The footer stays: Powered by ioPOS · Privacy.
  const links = [...page.document.querySelectorAll("footer a")].map((a) => [a.textContent, a.getAttribute("href")]);
  assertEquals(links, [["Powered by ioPOS", "/iopos-site/"], ["Privacy", "/iopos-site/privacy/"]]);
});

Deno.test("no tip, no discount, no payments: those rows are left out; no first name says Thank you", async () => {
  const page = await open(token, {
    status: 200,
    body: sample({
      customer_first_name: null, payments: [], refunds: [], discounts: [],
      order: { ...sample().order, status: "completed", discount_minor: 0, tip_minor: 0 },
    }),
  });
  const text = page.text();
  assertStringIncludes(text, "Thank you!");
  assertFalse(text.includes("Tip"));
  assertFalse(text.includes("Discount"));
  assertEquals(page.document.querySelector("[aria-label=Payments]"), null);
  assertEquals(page.document.querySelector(".status"), null);
});

Deno.test("shop-typed text is shown as text: no markup is ever created from the data", async () => {
  const attack = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
  const page = await open(token, {
    status: 200,
    body: sample({
      business: { ...sample().business, name: attack, address_line1: attack, brand_color: `ocean" onload="x` },
      customer_first_name: attack,
      lines: [{ name: attack, variant_name: attack, quantity: 1, modifiers: [attack], net_minor: 1 }],
      discounts: [{ name: attack, amount_minor: 62 }],
      payments: [{ ...sample().payments[1], card_brand: attack, card_last4: attack }],
    }),
  });
  assertEquals(page.content.querySelectorAll("img, script, iframe, [onerror], [onload]").length, 0);
  assertEquals(page.document.querySelector("header.brand h1")!.textContent, attack);
  assertStringIncludes(page.text(), `Thanks, ${attack}!`);
  // An unknown brand color falls back to caramel; it never becomes a class or style of its own.
  const classes = [...page.document.documentElement.classList];
  assertEquals(classes, ["brand-caramel"]);
  assertEquals(page.document.documentElement.getAttribute("style"), null);
});

Deno.test("a link without a well-formed token says so without asking the server", async () => {
  for (const t of [null, "", "short", `${token}!`, "a".repeat(65)]) {
    const page = await open(t);
    assertEquals(page.calls.length, 0, String(t));
    assertEquals(page.content.querySelector("h1")!.textContent, "Receipt not found");
    assertEquals(page.content.querySelector("button"), null);
  }
});

Deno.test("a receipt that isn't in the cloud yet says so, and Try again asks again", async () => {
  const page = await open(token, { status: 404, body: { error: "not_found" } }, { status: 200, body: sample() });
  assertEquals(page.content.querySelector("h1")!.textContent, "This receipt isn't here yet");
  assertStringIncludes(page.text(), "still on its way from the shop's phone");
  const retry = page.content.querySelector("button")!;
  assertEquals(retry.textContent, "Try again");
  retry.click();
  await settle();
  assertEquals(page.calls.length, 2);
  assertStringIncludes(page.text(), "Thanks, Maria!");
});

Deno.test("network and server errors offer Try again", async () => {
  for (const answer of [new TypeError("Failed to fetch"), { status: 500, body: { error: "server_error" } }]) {
    const page = await open(token, answer as Answer);
    assertEquals(page.content.querySelector("h1")!.textContent, "Couldn't load this receipt");
    assertStringIncludes(page.text(), "Check your internet connection");
    assertEquals(page.content.querySelector("button")!.textContent, "Try again");
  }
});

Deno.test("while loading, the page says so", async () => {
  const url = `https://levan2002.github.io/iopos-site/receipt/?t=${token}`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.fetch = () => new Promise(() => {}); // never answers
  dom.window.eval(script);
  await settle();
  const loading = dom.window.document.getElementById("loading")!;
  assertFalse(loading.hidden);
  assertEquals(loading.getAttribute("role"), "status");
  assertEquals(loading.textContent, "Loading your receipt…");
  assert(dom.window.document.getElementById("content")!.hidden);
});

Deno.test("the page is locked down: CSP, no referrer, no inline or third-party code, no innerHTML", () => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "script-src 'self'");
  assertStringIncludes(csp, "style-src 'self'");
  assertStringIncludes(csp, "connect-src https://leneddzaijxgvidtvwid.supabase.co;");
  assertStringIncludes(csp, "base-uri 'none'");
  assertStringIncludes(csp, "form-action 'none'");
  assertFalse(csp.includes("unsafe"));
  assertFalse(/https?:\/\/(?!leneddzaijxgvidtvwid\.supabase\.co)/.test(csp), "no other hosts");
  assertEquals(document.querySelector('meta[name="referrer"]')!.getAttribute("content"), "no-referrer");
  assertEquals(document.querySelector('meta[charset]')!.getAttribute("charset"), "utf-8");
  assert(document.querySelector('meta[name="viewport"]'));

  const scripts = [...document.querySelectorAll("script")];
  assertEquals(scripts.map((s) => s.getAttribute("src")), ["/iopos-site/receipt/receipt.js"]);
  assert(scripts.every((s) => s.textContent!.trim() === ""), "no inline script");
  assertEquals([...document.querySelectorAll("link[rel=stylesheet]")].map((l) => l.getAttribute("href")),
    ["/iopos-site/receipt/receipt.css"]);
  assertEquals(document.querySelectorAll("[style], style").length, 0, "no inline styles");

  const code = script.replace(/^\s*\/\/.*$/gm, ""); // the comments may name what the code never does
  assertFalse(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(code));
  assertEquals(scripts[0].getAttribute("type"), "module", "strict, deferred, nothing global");
  // The only request goes to the ioPOS receipt function.
  assertEquals([...script.matchAll(/https:\/\/[^"'\s]+/g)].map((m) => m[0]), [api]);
});

// ---------------------------------------------------------------------------------------------
// Spanish
// ---------------------------------------------------------------------------------------------

Deno.test("a browser in Spanish gets the receipt in Spanish, with dollars as $ and Spanish dates", async () => {
  const page = await openIn(["es-US", "en-US"], token, { status: 200, body: sample() });
  assertEquals(page.document.documentElement.lang, "es");
  assertEquals(page.document.title, "Recibo de Demo Coffee");
  const text = page.text();
  for (const expected of [
    "Demo Coffee", "Brooklyn, NY 11201",
    "¡Gracias, Maria!", "$7.08", "Pedido #A1-0042 · 29 sept 2026, 2:30 p.m. CDT", "Reembolso parcial",
    "Latte (Large)", "Oat, Extra shot", // the shop's words stay as typed
    "Subtotal$6.20", "10% off−$0.62", "Impuesto$0.50", "Propina$1.00", "Total$7.08",
    "Efectivo$5.00", "Cambio$0.92", "Visa •••• 4242$3.00",
    "Reembolsado el 30 sept 2026−$1.00", "Reembolso (en proceso)−$0.50",
  ]) {
    assertStringIncludes(text, expected);
  }
  for (const english of ["Thanks", "Order #", "Tax", "Tip", "Cash", "Change", "Refund"]) {
    assertFalse(text.includes(english), english);
  }
  assert(page.document.querySelector('[aria-label="Artículos"]'));
  assert(page.document.querySelector('[aria-label="Totales"]'));
  assert(page.document.querySelector('[aria-label="Pagos"]'));
  const links = [...page.document.querySelectorAll("footer a")].map((a) => [a.textContent, a.getAttribute("href")]);
  assertEquals(links, [["Con tecnología de ioPOS", "/iopos-site/"], ["Privacidad", "/iopos-site/privacy/"]]);
});

Deno.test("Spanish: no first name says ¡Gracias!; one discount row, card and other tenders, voided", async () => {
  const page = await openIn(["es"], token, {
    status: 200,
    body: sample({
      customer_first_name: null, refunds: [], discounts: [{ name: "Happy hour", amount_minor: 10 }],
      order: { ...sample().order, status: "voided" },
      payments: [
        { ...sample().payments[1], card_brand: null, card_last4: null },
        { ...sample().payments[1], tender: "other", card_brand: null, card_last4: null },
      ],
    }),
  });
  const text = page.text();
  for (const expected of ["¡Gracias!", "Descuento−$0.62", "Tarjeta$3.00", "Otro$3.00"]) {
    assertStringIncludes(text, expected);
  }
  assertEquals(page.document.querySelector(".status")!.textContent, "Anulado");
  const refunded = await openIn(["es-US"], token, { status: 200, body: sample({ order: { ...sample().order, status: "refunded" } }) });
  assertEquals(refunded.document.querySelector(".status")!.textContent, "Reembolsado");
});

Deno.test("the language is the browser's first one; Spanish money and dates follow its region", async () => {
  const cases: [string[], string, string, string][] = [
    // languages, <html lang>, total, a line of the summary
    [["es"], "es", "$7.08", "Pedido #A1-0042 · 29 sept 2026, 2:30 p.m. CDT"], // no region: es-US
    [["es-MX", "en"], "es", "USD 7.08", "Pedido #A1-0042 · 29 sep 2026, 2:30 p.m."],
    [["es-ES"], "es", "7,08 US$", "Pedido #A1-0042 · 29 sept 2026, 14:30"],
    [["en-GB", "es-US"], "en", "$7.08", "Order #A1-0042 · Sep 29, 2026, 2:30 PM CDT"], // English stays en-US
    [["fr-FR", "es"], "en", "$7.08", "Thanks, Maria!"], // only the first language counts
    [["estonian"], "en", "$7.08", "Order #A1-0042"],
    [[], "en", "$7.08", "Order #A1-0042"],
  ];
  for (const [languages, lang, total, line] of cases) {
    const page = await openIn(languages, token, { status: 200, body: sample() });
    const label = languages.join(",");
    assertEquals(page.document.documentElement.lang, lang, label);
    assertEquals(spaces(page.document.querySelector(".total")!.textContent!), total, label);
    assertStringIncludes(page.text(), line, label);
  }
});

Deno.test("Spanish: loading, not-a-receipt, not-yet and error pages, with Reintentar", async () => {
  const url = `https://levan2002.github.io/iopos-site/receipt/?t=${token}`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  prefer(dom.window, ["es-US"]);
  dom.window.fetch = () => new Promise(() => {}); // never answers
  dom.window.eval(script);
  await settle();
  assertEquals(dom.window.document.getElementById("loading")!.textContent, "Cargando su recibo…");
  assertEquals(dom.window.document.title, "Su recibo · ioPOS");
  assertEquals(dom.window.document.documentElement.lang, "es");

  const bad = await openIn(["es-US"], "short");
  assertEquals(bad.content.querySelector("h1")!.textContent, "Recibo no encontrado");
  assertStringIncludes(bad.text(), "Este enlace no es un recibo.");
  assertEquals(bad.content.querySelector("button"), null);

  const notYet = await openIn(["es-US"], token, { status: 404, body: { error: "not_found" } }, { status: 200, body: sample() });
  assertEquals(notYet.content.querySelector("h1")!.textContent, "Este recibo aún no está disponible");
  assertStringIncludes(notYet.text(), "en camino desde el celular del negocio");
  const retry = notYet.content.querySelector("button")!;
  assertEquals(retry.textContent, "Reintentar");
  retry.click();
  await settle();
  assertStringIncludes(notYet.text(), "¡Gracias, Maria!");

  const failed = await openIn(["es-US"], token, new TypeError("Failed to fetch"));
  assertEquals(failed.content.querySelector("h1")!.textContent, "No se pudo cargar este recibo");
  assertStringIncludes(failed.text(), "Revise su conexión a internet");
  assertEquals(failed.content.querySelector("button")!.textContent, "Reintentar");
});

Deno.test("Spanish keeps shop-typed text as text: the name in ¡Gracias, …! never becomes markup", async () => {
  const attack = `<img src=x onerror="alert(1)">`;
  const page = await openIn(["es-US"], token, {
    status: 200,
    body: sample({ customer_first_name: attack, business: { ...sample().business, name: attack } }),
  });
  assertEquals(page.content.querySelectorAll("img, [onerror]").length, 0);
  assertStringIncludes(page.text(), `¡Gracias, ${attack}!`);
  assertEquals(page.document.title, `Recibo de ${attack}`);
});
