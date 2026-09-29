// The ioPOS receipt page. A receipt link is /iopos-site/receipt/?t=<token>: this page fetches the
// receipt for that token from the ioPOS server as JSON and shows it.
//
// Everything in the receipt was typed by a shop, so it is untrusted: the page is built with
// createElement and textContent only (never as markup), and the brand color is one of a fixed set
// of CSS classes. The Content-Security-Policy in index.html allows only this script, the page's
// stylesheet and requests to the ioPOS server. Loaded as a module: strict, and nothing global.
//
// The page is in Spanish when the browser's first language is Spanish, in English otherwise (TEXT).

const RECEIPT_API = "https://leneddzaijxgvidtvwid.supabase.co/functions/v1/receipt";
// The app makes 43 characters (32 random bytes, base64url); the server accepts 32 to 64.
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const BRANDS = ["caramel", "evergreen", "cherry", "plum", "indigo", "ocean", "teal", "forest", "graphite"];

// --- Language -------------------------------------------------------------------------------------

// Spanish when the browser's first language is Spanish, English otherwise. Only this page's own
// words are translated; everything the shop typed (names, items, discounts) is shown as typed.
const TEXT = {
  en: {
    pageTitle: "Your receipt · ioPOS",
    loading: "Loading your receipt…",
    poweredBy: "Powered by ioPOS",
    privacy: "Privacy",
    receiptFrom: (name) => `Receipt from ${name}`,
    thanksName: (name) => `Thanks, ${name}!`,
    thanks: "Thank you!",
    order: (number, date) => `Order #${number} · ${date}`,
    status: { refunded: "Refunded", partially_refunded: "Partly refunded", voided: "Voided" },
    items: "Items",
    totals: "Totals",
    payments: "Payments",
    subtotal: "Subtotal",
    discount: "Discount",
    tax: "Tax",
    tip: "Tip",
    total: "Total",
    cash: "Cash",
    card: "Card",
    other: "Other",
    change: "Change",
    refundPending: "Refund (processing)",
    refunded: (date) => `Refunded ${date}`,
    tryAgain: "Try again",
    notFoundTitle: "Receipt not found",
    notFoundText: "This link isn't a receipt. Check that the whole link was copied, or ask the shop to send it again.",
    notYetTitle: "This receipt isn't here yet",
    notYetText: "If you just paid, your receipt is probably still on its way from the shop's phone. " +
      "Try again in a few minutes. If it still doesn't show, check the link or ask the shop to send it again.",
    errorTitle: "Couldn't load this receipt",
    errorText: "Check your internet connection, then try again.",
  },
  es: {
    pageTitle: "Su recibo · ioPOS",
    loading: "Cargando su recibo…",
    poweredBy: "Con tecnología de ioPOS",
    privacy: "Privacidad",
    receiptFrom: (name) => `Recibo de ${name}`,
    thanksName: (name) => `¡Gracias, ${name}!`,
    thanks: "¡Gracias!",
    order: (number, date) => `Pedido #${number} · ${date}`,
    status: { refunded: "Reembolsado", partially_refunded: "Reembolso parcial", voided: "Anulado" },
    items: "Artículos",
    totals: "Totales",
    payments: "Pagos",
    subtotal: "Subtotal",
    discount: "Descuento",
    tax: "Impuesto",
    tip: "Propina",
    total: "Total",
    cash: "Efectivo",
    card: "Tarjeta",
    other: "Otro",
    change: "Cambio",
    refundPending: "Reembolso (en proceso)",
    refunded: (date) => `Reembolsado el ${date}`,
    tryAgain: "Reintentar",
    notFoundTitle: "Recibo no encontrado",
    notFoundText: "Este enlace no es un recibo. Verifique que copió el enlace completo o pida al negocio que se lo envíe de nuevo.",
    notYetTitle: "Este recibo aún no está disponible",
    notYetText: "Si acaba de pagar, es probable que su recibo todavía esté en camino desde el celular del negocio. " +
      "Vuelva a intentarlo en unos minutos. Si aún no aparece, revise el enlace o pida al negocio que se lo envíe de nuevo.",
    errorTitle: "No se pudo cargar este recibo",
    errorText: "Revise su conexión a internet y vuelva a intentarlo.",
  },
};

/**
 * The page's language ("en" or "es") and the locale for money and dates: "en-US" in English; in
 * Spanish the browser's own tag when it names a region ("es-MX"), else "es-US" (ioPOS shops are in
 * the US, and "es-US" writes dollars as "$7.08").
 */
function pickLanguage(nav) {
  const first = String((nav && nav.languages && nav.languages[0]) || (nav && nav.language) || "");
  if (!/^es(-|$)/i.test(first)) return { lang: "en", locale: "en-US" };
  let locale = "es-US";
  try {
    const [canonical] = Intl.getCanonicalLocales(first);
    if (canonical && canonical.includes("-") && Intl.NumberFormat.supportedLocalesOf([canonical]).length) locale = canonical;
  } catch {
    // Not a valid language tag: keep es-US.
  }
  return { lang: "es", locale };
}

const { lang: LANG, locale: LOCALE } = pickLanguage(typeof navigator === "undefined" ? null : navigator);
const T = TEXT[LANG];

/** The page's own words in the chosen language: <html lang>, the title and [data-text] elements. */
function translateStaticText() {
  document.documentElement.lang = LANG;
  document.title = T.pageTitle;
  for (const node of document.querySelectorAll("[data-text]")) {
    const text = T[node.getAttribute("data-text")];
    if (typeof text === "string") node.textContent = text;
  }
}

// --- DOM ------------------------------------------------------------------------------------------

/** An element with a class and text; the text is always set as text, never parsed as markup. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function row(label, amount, className) {
  const node = el("div", className ? `row ${className}` : "row");
  node.append(el("span", null, label), el("span", "amount", amount));
  return node;
}

// --- Formatting -----------------------------------------------------------------------------------

function money(minor, currency) {
  try {
    const formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits;
    return formatter.format(minor / 10 ** digits);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

function inZone(iso, timeZone, options) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: timeZone || "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" }).format(date);
  }
}

/** "Sep 29, 2026, 2:30 PM CDT" (in Spanish "29 sept 2026, 2:30 p.m. CDT") in the shop's time zone. */
function dateTime(iso, timeZone) {
  return inZone(iso, timeZone, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function dateOnly(iso, timeZone) {
  return inZone(iso, timeZone, { year: "numeric", month: "short", day: "numeric" });
}

/** "2.000" → "2", "1.500" → "1.5". */
function quantity(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? String(Math.round(number * 1000) / 1000) : String(value);
}

/** "Latte (Large)", leaving out the "Regular" variant, as the app does. */
function lineName(line) {
  const variant = line.variant_name ? String(line.variant_name).trim() : "";
  return variant && variant !== "Regular" ? `${line.name} (${variant})` : line.name;
}

function paymentLabel(payment) {
  if (payment.tender === "cash") return T.cash;
  if (payment.tender === "card_present") {
    const brand = payment.card_brand
      ? payment.card_brand.charAt(0).toUpperCase() + payment.card_brand.slice(1).toLowerCase()
      : T.card;
    return payment.card_last4 ? `${brand} •••• ${payment.card_last4}` : brand;
  }
  return T.other;
}

// --- Rendering ------------------------------------------------------------------------------------

function header(business) {
  const node = el("header", "brand");
  node.append(el("h1", null, business.name));
  const cityLine = [[business.city, business.region].filter(Boolean).join(", "), business.postal_code]
    .filter(Boolean).join(" ");
  for (const text of [business.address_line1, business.address_line2, cityLine, business.phone]) {
    if (text && String(text).trim()) node.append(el("p", null, text));
  }
  return node;
}

function receipt(data) {
  const business = data.business || {};
  const order = data.order || {};
  const lines = data.lines || [];
  const discounts = data.discounts || [];
  const payments = data.payments || [];
  const refunds = data.refunds || [];
  const amount = (minor) => money(minor, order.currency);
  const minus = (minor) => "−" + money(minor, order.currency);

  const summary = el("section", "summary");
  summary.append(
    el("p", "thanks", data.customer_first_name ? T.thanksName(data.customer_first_name) : T.thanks),
    el("p", "total", amount(order.total_minor)),
    el("p", "meta", T.order(order.number, dateTime(order.created_at, business.timezone))),
  );
  if (Object.prototype.hasOwnProperty.call(T.status, order.status)) summary.append(el("p", "status", T.status[order.status]));

  const items = el("section");
  items.setAttribute("aria-label", T.items);
  const list = el("ul", "lines");
  for (const line of lines) {
    const label = el("span");
    label.append(el("span", "qty", `${quantity(line.quantity)} ×`), document.createTextNode(` ${lineName(line)}`));
    const top = el("div", "row");
    top.append(label, el("span", "amount", amount(line.net_minor)));
    const item = el("li");
    item.append(top);
    if (line.modifiers && line.modifiers.length) item.append(el("p", "detail", line.modifiers.join(", ")));
    list.append(item);
  }
  items.append(list);

  const totals = el("section", "totals");
  totals.setAttribute("aria-label", T.totals);
  totals.append(row(T.subtotal, amount(order.subtotal_minor)));
  if (order.discount_minor > 0) {
    // Named discounts when they add up to the order's discount; one "Discount" row otherwise.
    const named = discounts.reduce((sum, d) => sum + d.amount_minor, 0) === order.discount_minor;
    if (named) {
      for (const d of discounts) totals.append(row(d.name, minus(d.amount_minor)));
    } else {
      totals.append(row(T.discount, minus(order.discount_minor)));
    }
  }
  totals.append(row(T.tax, amount(order.tax_minor)));
  if (order.tip_minor > 0) totals.append(row(T.tip, amount(order.tip_minor)));
  totals.append(row(T.total, amount(order.total_minor), "grand"));

  const main = el("main");
  main.append(summary, items, totals);

  if (payments.length || refunds.length) {
    const paid = el("section", "totals");
    paid.setAttribute("aria-label", T.payments);
    for (const payment of payments) {
      const cash = payment.tender === "cash";
      const given = cash && payment.cash_tendered_minor !== null ? payment.cash_tendered_minor : payment.amount_minor;
      paid.append(row(paymentLabel(payment), amount(given)));
      if (cash && payment.change_minor > 0) paid.append(row(T.change, amount(payment.change_minor)));
    }
    for (const refund of refunds) {
      const label = refund.status === "pending"
        ? T.refundPending
        : T.refunded(dateOnly(refund.created_at, business.timezone));
      paid.append(row(label, minus(refund.amount_minor)));
    }
    main.append(paid);
  }

  const brand = BRANDS.includes(business.brand_color) ? business.brand_color : "caramel";
  document.documentElement.classList.add(`brand-${brand}`);
  document.title = T.receiptFrom(business.name);
  const fragment = document.createDocumentFragment();
  fragment.append(header(business), main);
  return fragment;
}

function message(title, text, retry) {
  const box = el("div", "message");
  box.append(el("h1", null, title), el("p", null, text));
  if (retry) {
    const button = el("button", null, T.tryAgain);
    button.type = "button";
    button.addEventListener("click", retry);
    box.append(button);
  }
  return box;
}

function show(node) {
  const content = document.getElementById("content");
  content.replaceChildren(node);
  content.hidden = false;
  document.getElementById("loading").hidden = true;
}

// --- Loading --------------------------------------------------------------------------------------

async function load() {
  const token = new URLSearchParams(location.search).get("t") || "";
  if (!TOKEN.test(token)) {
    show(message(T.notFoundTitle, T.notFoundText));
    return;
  }
  document.getElementById("content").hidden = true;
  document.getElementById("loading").hidden = false;
  try {
    const url = `${RECEIPT_API}?t=${encodeURIComponent(token)}&format=json`;
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (response.status === 404) {
      show(message(T.notYetTitle, T.notYetText, load));
      return;
    }
    if (!response.ok) throw new Error(`status ${response.status}`);
    show(receipt(await response.json()));
  } catch {
    show(message(T.errorTitle, T.errorText, load));
  }
}

function start() {
  translateStaticText();
  load();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
