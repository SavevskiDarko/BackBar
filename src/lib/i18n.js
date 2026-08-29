/* ===========================================================================
   Language.

   The English string is the key. A missing translation falls back to English
   rather than showing a raw key like "order.save" — so a half-finished
   dictionary is usable, and adding a phrase never breaks a screen.

   MK below is a first pass and wants a native eye, particularly the bar
   vocabulary. Correcting a line here changes it everywhere; nothing else
   needs touching.
   =========================================================================== */

export const LANGUAGES = {
  en: { name: "English", flag: "EN" },
  mk: { name: "Македонски", flag: "МК" },
};

const MK = {
  // --- signing in -----------------------------------------------------------
  "Set up this device": "Постави го уредот",
  "Enter the bar's code — you only do this once": "Внеси го кодот на локалот — само еднаш",
  "Enter your PIN to open the floor": "Внеси го твојот ПИН",
  "Platform sign-in": "Најава за платформа",
  "The account that runs the whole network": "Сметка што управува со сите локали",
  "Not this bar?": "Не е овој локал?",
  "Forgotten your PIN?": "Го заборави ПИН-от?",
  "Where do I get a code?": "Каде да добијам код?",
  "PIN not recognised": "ПИН-от не е препознаен",
  "No bar uses that code": "Нема локал со тој код",
  "Sign in": "Најави се",
  "Signing in…": "Се најавува…",
  "Email": "Е-пошта",
  "Password": "Лозинка",
  "CLEAR": "БРИШИ",

  // --- the floor ------------------------------------------------------------
  "Floor": "Сала",
  "Tap a table to take the order": "Допри маса за нарачка",
  "Open bills": "Отворени сметки",
  "items": "ставки",
  "guests": "гости",
  "you": "ти",
  "open": "отворена",
  "new bill": "нова сметка",
  "free": "слободна",
  "saved on this device": "зачувано на овој уред",
  "This room has no tables yet.": "Оваа просторија сè уште нема маси.",
  "Ask the owner to lay out the floor.": "Побарај од сопственикот да ја постави салата.",

  // --- taking an order ------------------------------------------------------
  "Table": "Маса",
  "Takeaway": "За носење",
  "Order": "Нарачка",
  "Order copied": "Нарачката е копирана",
  "Find a drink": "Најди пијалак",
  "All": "Сите",
  "Nothing matches. Try another category.": "Нема резултати. Пробај друга категорија.",
  "Nothing ordered yet. Tap a drink to start the bill.": "Сè уште нема нарачка. Допри пијалак за да почнеш.",
  "Save order": "Зачувај нарачка",
  "Close bill": "Затвори сметка",
  "Bill": "Сметка",
  "Back to the menu": "Назад кон менито",
  "TOTAL": "ВКУПНО",
  "GUESTS": "ГОСТИ",
  "ITEMS": "СТАВКИ",
  "each": "по парче",
  "on this bill": "на оваа сметка",
  "one less": "еден помалку",
  "one more": "еден повеќе",

  // --- paying ---------------------------------------------------------------
  "DID THEY PAY?": "ДАЛИ ПЛАТИЈА?",
  "Cash": "Готовина",
  "Card": "Картичка",
  "Not paid — leave on the tab": "Не е платено — остави на сметка",
  "Back": "Назад",
  "no disc.": "без попуст",
  "Split between cash and card": "Подели готовина и картичка",
  "CASH": "ГОТОВИНА",
  "CARD": "КАРТИЧКА",
  "adds up": "се совпаѓа",
  "off by": "разлика од",
  "of": "од",
  "Company receipt (ЕДБ)": "Сметка за фирма (ЕДБ)",
  "BUYER": "КУПУВАЧ",
  "Company name": "Име на фирма",
  "Save the order first, then you can close the bill.":
    "Прво зачувај ја нарачката, потоа можеш да ја затвориш сметката.",

  // --- splitting a bill -----------------------------------------------------
  "Someone's leaving — pay part": "Некој си оди — плати дел",
  "WHAT ARE THEY PAYING FOR?": "ШТО ПЛАЌААТ?",
  "THIS GUEST": "ОВОЈ ГОСТ",
  "stays on the table": "останува на масата",

  // --- connection -----------------------------------------------------------
  "Offline": "Офлајн",
  "to sync": "за синхронизација",
  "Send now": "Испрати сега",
  "Opening the floor…": "Се отвора салата…",
  "Starting up…": "Се вклучува…",
  "New version ready — tap to update": "Нова верзија — допри за ажурирање",
  "Press back again to leave Backbar": "Притисни назад повторно за излез",
  "Sign out": "Одјави се",

  // --- roles ----------------------------------------------------------------
  "Bar owner": "Сопственик",
  "Waiter": "Келнер",
  "Serving": "Служи",
  "Serve": "Служи",
  "Manage": "Управувај",
};

const DICTS = { en: {}, mk: MK };

let current = "en";

export function setLang(code) {
  current = DICTS[code] ? code : "en";
  if (typeof document !== "undefined") document.documentElement.lang = current;
  try { localStorage.setItem("backbar.lang", current); } catch { /* private mode */ }
}

export function getLang() {
  return current;
}

export function recallLang() {
  try {
    const saved = localStorage.getItem("backbar.lang");
    if (saved && DICTS[saved]) return saved;
  } catch { /* ignore */ }
  // Fall back to the device: a Macedonian phone should open in Macedonian.
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  return nav.toLowerCase().startsWith("mk") ? "mk" : "en";
}

/** Translate. The English text is the key, so an untranslated phrase still
    reads correctly rather than showing an identifier. */
export function t(text) {
  const d = DICTS[current];
  return (d && d[text]) || text;
}
