// Service worker: registro desatendido de jornadas.
//
// Cada vez que se dispara (arranque de Chrome, alarma periódica, alarma de la
// hora de corte o renovación del token) consulta los últimos días en Woffu y
// registra los laborables vencidos que sigan vacíos. Es idempotente: si el
// ordenador estuvo apagado varios días, la siguiente ejecución los rellena.

import { loadConfig, saveConfig } from "./config.js";
import { fetchDiaryRange, fetchExistingSlotCount, buildSlotPayload, sendWorkdaySlots } from "./api.js";
import {
  addDays,
  decodeJwtPayload,
  evaluateAutoFill,
  lastDueDate,
  localDateString,
  scheduleBlocksForDiary,
  timeToMinutes
} from "./schedule.js";

const TICK_ALARM = "woffu-auto-tick";
const CUTOFF_ALARM = "woffu-auto-cutoff";
const RENEW_CLOSE_ALARM = "woffu-renew-close";
const TICK_MINUTES = 30;
const LOOKBACK_DAYS = 45;
// El JWT dura ~360 días desde el login y la web de Woffu no lo renueva
// mientras siga vigente: solo un login nuevo emite otro. Se avisa con
// antelación para renovarlo a mano con "Renew session".
const RENEW_BEFORE_DAYS = 14;
const RENEW_RETRY_HOURS = 12;
const LOG_KEY = "autoLog";
const STATE_KEY = "autoState";
const MAX_LOG_ENTRIES = 100;
const ICON = chrome.runtime.getURL("icons/icon128.png");

let inFlight = null;

// ---------------------------------------------------------------------------
// Utilidades de almacenamiento, log y avisos
// ---------------------------------------------------------------------------

async function getState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  return result[STATE_KEY] || {};
}

async function patchState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

async function log(level, message) {
  const result = await chrome.storage.local.get(LOG_KEY);
  const entries = result[LOG_KEY] || [];
  entries.push({ ts: new Date().toISOString(), level, message });
  await chrome.storage.local.set({ [LOG_KEY]: entries.slice(-MAX_LOG_ENTRIES) });
  console[level === "error" ? "error" : "info"](`[TofuPalWoffu] ${message}`);
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: "basic", iconUrl: ICON, title, message, priority: 1 });
}

async function setBadge(problem) {
  await chrome.action.setBadgeText({ text: problem ? "!" : "" });
  if (problem) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d64545" });
  }
}

// Avisos que solo deben salir una vez al día (token, errores repetidos…).
async function notifyOncePerDay(key, title, message) {
  const today = localDateString(new Date());
  const state = await getState();
  const sent = state.notifiedOn || {};
  if (sent[key] === today) {
    return;
  }
  notify(key, title, message);
  await patchState({ notifiedOn: { ...sent, [key]: today } });
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

function sessionState(session) {
  return {
    tokenExp: session?.exp ? new Date(session.exp).toISOString() : null,
    tokenIat: session?.iat ? new Date(session.iat).toISOString() : null
  };
}

async function readCookieToken(baseUrl) {
  if (!baseUrl) {
    return null;
  }
  try {
    const cookie = await chrome.cookies.get({ url: baseUrl, name: "woffu.token" });
    return cookie?.value?.trim() || null;
  } catch {
    return null;
  }
}

// El token vigente sale de la cookie que mantiene la web de Woffu; el guardado
// en la configuración es solo el respaldo.
async function resolveSession(config) {
  const cookieToken = await readCookieToken(config.baseUrl);
  if (cookieToken && cookieToken !== config.bearerToken) {
    config.bearerToken = cookieToken;
    await saveConfig(config);
  }
  const token = config.bearerToken;
  const payload = token ? decodeJwtPayload(token) : null;
  const exp = payload?.exp ? payload.exp * 1000 : null;
  const iat = payload?.iat ? payload.iat * 1000 : null;
  if (!config.userId && payload) {
    const userId = payload.UserId ?? payload.userid ?? payload.userId;
    if (userId) {
      config.userId = String(userId);
      await saveConfig(config);
    }
  }
  return {
    token,
    exp,
    iat,
    expired: !token || !exp || exp <= Date.now()
  };
}

// Abre Woffu en una pestaña en segundo plano: si la sesión de Microsoft sigue
// viva, el SSO termina solo y Woffu deja una cookie nueva (ver onChanged).
async function tryRenewSession(config) {
  const state = await getState();
  const lastAttempt = state.renewAttemptAt ? Date.parse(state.renewAttemptAt) : 0;
  if (Date.now() - lastAttempt < RENEW_RETRY_HOURS * 3600 * 1000) {
    return;
  }
  const tab = await chrome.tabs.create({ url: `${config.baseUrl}/v2/home`, active: false });
  await patchState({ renewAttemptAt: new Date().toISOString(), renewTabId: tab.id });
  chrome.alarms.create(RENEW_CLOSE_ALARM, { delayInMinutes: 3 });
  await log("info", "Opened Woffu in a background tab to renew the session.");
}

async function closeRenewTab() {
  const state = await getState();
  if (state.renewTabId == null) {
    return;
  }
  try {
    await chrome.tabs.remove(state.renewTabId);
  } catch {
    // El usuario ya la cerró.
  }
  await patchState({ renewTabId: null });
}

// ---------------------------------------------------------------------------
// Ejecución principal
// ---------------------------------------------------------------------------

async function scheduleCutoffAlarm(config) {
  const cutoff = timeToMinutes(config.autoCutoff || "17:31");
  const next = new Date();
  next.setHours(Math.floor(cutoff / 60), cutoff % 60, 30, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  chrome.alarms.create(CUTOFF_ALARM, { when: next.getTime() });
}

async function ensureAlarms() {
  const tick = await chrome.alarms.get(TICK_ALARM);
  if (!tick) {
    chrome.alarms.create(TICK_ALARM, { delayInMinutes: 1, periodInMinutes: TICK_MINUTES });
  }
  await scheduleCutoffAlarm(await loadConfig());
}

// Calcula qué días hay que registrar. Con dryRun no envía nada.
async function reconcile({ trigger, dryRun }) {
  const config = await loadConfig();
  const startedAt = new Date().toISOString();

  if (!config.autoEnabled && !dryRun && trigger !== "manual") {
    return { skipped: "Automatic mode is disabled." };
  }
  if (!config.baseUrl) {
    await setBadge(true);
    return { error: "Base URL not configured. Open the popup on a Woffu tab first." };
  }

  const session = await resolveSession(config);
  await patchState(sessionState(session));

  if (session.expired) {
    await setBadge(true);
    if (config.autoRenew && !dryRun) {
      await tryRenewSession(config);
    }
    await notifyOncePerDay(
      "token-expired",
      "Woffu: session expired",
      "Open Woffu and log in so pending days can be registered."
    );
    return { error: "Woffu session expired." };
  }

  const daysLeft = (session.exp - Date.now()) / 86400000;
  if (daysLeft < RENEW_BEFORE_DAYS) {
    await setBadge(true);
    await notifyOncePerDay(
      "token-expiring",
      "Woffu: session expires soon",
      `Your Woffu session expires in ${Math.ceil(daysLeft)} day(s). Open the extension and press “Renew session”.`
    );
  }

  const dueUntil = lastDueDate(new Date(), config.autoCutoff || "17:31");
  const from = addDays(localDateString(new Date()), -LOOKBACK_DAYS);

  let summary;
  try {
    summary = await fetchDiaryRange(config, from, dueUntil);
  } catch (error) {
    if (error.status === 401) {
      await setBadge(true);
      await notifyOncePerDay("token-rejected", "Woffu: session rejected", "Open Woffu and log in again.");
    }
    throw error;
  }

  const candidates = (summary.diaries || [])
    .filter(diary => diary.date.slice(0, 10) <= dueUntil)
    .filter(diary => evaluateAutoFill(diary).ok)
    .sort((a, b) => a.date.localeCompare(b.date));

  const plan = candidates.map(diary => {
    const schedule = scheduleBlocksForDiary(diary, config);
    return {
      date: diary.date.slice(0, 10),
      blocks: schedule.slots.map(slot => `${slot.start}-${slot.end}`).join(", "),
      source: schedule.source,
      note: schedule.reason || schedule.warning || null,
      diary
    };
  });

  if (dryRun) {
    return {
      dryRun: true,
      range: { from, to: dueUntil },
      days: plan.map(({ diary, ...rest }) => rest)
    };
  }

  const registered = [];
  const failed = [];
  for (const item of plan) {
    // Recomprobación justo antes del PUT, que reemplaza los slots del día.
    const existing = await fetchExistingSlotCount(config, item.diary.diarySummaryId).catch(() => null);
    if (existing) {
      await log("info", `${item.date}: skipped, already has ${existing} slot(s).`);
      continue;
    }
    const result = await sendWorkdaySlots(buildSlotPayload(item.diary, config), config)
      .catch(error => ({ ok: false, status: 0, body: error.message }));
    if (result.ok) {
      registered.push(item);
      await log("info", `${item.date}: registered ${item.blocks} (${item.source}).`);
    } else {
      failed.push(item);
      const detail = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      await log("error", `${item.date}: failed (${result.status}) ${detail?.slice(0, 200)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (registered.length) {
    notify(
      `registered-${Date.now()}`,
      `Woffu: ${registered.length} day(s) registered`,
      registered.map(item => `${item.date}: ${item.blocks}`).join("\n")
    );
  }
  if (failed.length) {
    notify(
      `failed-${Date.now()}`,
      `Woffu: ${failed.length} day(s) failed`,
      `${failed.map(item => item.date).join(", ")}. It will retry automatically.`
    );
  }

  await setBadge(failed.length > 0);
  await patchState({
    lastRunAt: startedAt,
    lastTrigger: trigger,
    lastResult: { registered: registered.length, failed: failed.length, pending: plan.length },
    ...(failed.length ? {} : { lastSuccessAt: startedAt }),
    lastError: failed.length ? `${failed.length} day(s) failed` : null
  });
  return {
    registered: registered.map(item => item.date),
    failed: failed.map(item => item.date)
  };
}

async function runAuto(trigger, { dryRun = false } = {}) {
  // Un único service worker: basta con encadenar las ejecuciones en memoria
  // para que dos disparos simultáneos no envíen el mismo día dos veces.
  const previous = inFlight || Promise.resolve();
  inFlight = previous.catch(() => {}).then(async () => {
    try {
      const result = await reconcile({ trigger, dryRun });
      if (result.error) {
        await log("error", `[${trigger}] ${result.error}`);
        if (!dryRun) {
          await patchState({ lastRunAt: new Date().toISOString(), lastTrigger: trigger, lastError: result.error });
        }
      } else if (!dryRun && !result.skipped && !result.registered.length && !result.failed.length) {
        await setBadge(false);
      }
      return result;
    } catch (error) {
      await log("error", `[${trigger}] ${error.message}`);
      await patchState({ lastRunAt: new Date().toISOString(), lastTrigger: trigger, lastError: error.message });
      await setBadge(true);
      return { error: error.message };
    } finally {
      await scheduleCutoffAlarm(await loadConfig());
    }
  });
  return inFlight;
}

// ---------------------------------------------------------------------------
// Autodiagnóstico: comprueba cada pieza de la que depende el registro desatendido
// ---------------------------------------------------------------------------

async function healthCheck() {
  const config = await loadConfig();
  const state = await getState();
  const checks = [];
  const add = (name, ok, detail, level = ok ? "ok" : "error") => checks.push({ name, ok, level, detail });

  add(
    "Automatic mode",
    Boolean(config.autoEnabled),
    config.autoEnabled ? `enabled, registers from ${config.autoCutoff}` : "disabled: enable the toggle above",
    config.autoEnabled ? "ok" : "warning"
  );

  const tick = await chrome.alarms.get(TICK_ALARM);
  const cutoff = await chrome.alarms.get(CUTOFF_ALARM);
  add(
    "Scheduler",
    Boolean(tick && cutoff),
    tick && cutoff
      ? `next check ${new Date(tick.scheduledTime).toLocaleTimeString()}, next cutoff run ${new Date(cutoff.scheduledTime).toLocaleString()}`
      : "alarms missing (they are recreated now)"
  );
  if (!tick || !cutoff) {
    await ensureAlarms();
  }

  let session = null;
  if (!config.baseUrl) {
    add("Woffu session", false, "base URL not configured: open the popup on a Woffu tab");
  } else {
    session = await resolveSession(config);
    await patchState(sessionState(session));
    if (session.expired) {
      add("Woffu session", false, "expired: use “Renew session”");
    } else {
      const daysLeft = (session.exp - Date.now()) / 86400000;
      add(
        "Woffu session",
        true,
        `valid until ${new Date(session.exp).toLocaleString()} (${daysLeft.toFixed(1)} days)`,
        daysLeft < RENEW_BEFORE_DAYS ? "warning" : "ok"
      );
    }
  }

  if (session && !session.expired) {
    try {
      const today = localDateString(new Date());
      const summary = await fetchDiaryRange(config, today, today);
      const diary = summary.diaries?.[0];
      const detail = diary
        ? `OK, today: ${diary.isWeekend ? "weekend" : diary.isHoliday ? "holiday" : scheduleBlocksForDiary(diary, config).slots.map(slot => `${slot.start}-${slot.end}`).join(", ")}`
        : "OK";
      add("Woffu API", true, detail);
    } catch (error) {
      add("Woffu API", false, error.message.slice(0, 160));
    }
  }

  if (!state.lastRunAt) {
    add("Last run", false, "never ran yet", "warning");
  } else {
    const hoursAgo = (Date.now() - Date.parse(state.lastRunAt)) / 3600000;
    const stale = config.autoEnabled && hoursAgo > 2;
    const detail = `${new Date(state.lastRunAt).toLocaleString()} (${state.lastTrigger})` +
      (state.lastError ? ` — ${state.lastError}` : "") +
      (stale ? " — no run in the last 2 hours" : "");
    add("Last run", !state.lastError && !stale, detail, state.lastError ? "error" : stale ? "warning" : "ok");
  }

  const level = checks.some(check => check.level === "error")
    ? "error"
    : checks.some(check => check.level === "warning") ? "warning" : "ok";
  return { level, checkedAt: new Date().toISOString(), checks };
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  runAuto("installed");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  runAuto("startup");
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RENEW_CLOSE_ALARM) {
    closeRenewTab();
    return;
  }
  if (alarm.name === TICK_ALARM || alarm.name === CUTOFF_ALARM) {
    runAuto(alarm.name === CUTOFF_ALARM ? "cutoff" : "tick");
  }
});

// Woffu ha emitido un token nuevo (login manual o renovación en segundo plano).
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed || cookie.name !== "woffu.token" || !cookie.domain.endsWith("woffu.com")) {
    return;
  }
  const config = await loadConfig();
  if (cookie.value === config.bearerToken) {
    return;
  }
  config.bearerToken = cookie.value;
  await saveConfig(config);
  await log("info", "Woffu session token updated from cookie.");
  await closeRenewTab();
  runAuto("token-renewed");
});

chrome.notifications.onClicked.addListener(async () => {
  const config = await loadConfig();
  if (config.baseUrl) {
    chrome.tabs.create({ url: `${config.baseUrl}/v2/home` });
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "autoPlan") {
    runAuto("manual", { dryRun: true }).then(sendResponse);
    return true;
  }
  if (request.action === "autoRun") {
    runAuto("manual").then(sendResponse);
    return true;
  }
  if (request.action === "autoSettingsChanged") {
    ensureAlarms().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.action === "autoHealth") {
    healthCheck().then(sendResponse, error => sendResponse({ level: "error", checks: [], error: error.message }));
    return true;
  }
  if (request.action === "renewNow") {
    // Renovación manual: se borra la cookie para forzar un login nuevo (Woffu no
    // reemite el token mientras siga vigente). El token anterior sigue guardado
    // en la configuración y vale hasta su caducidad. El nuevo se recoge solo en
    // cookies.onChanged.
    loadConfig().then(async config => {
      if (!config.baseUrl) {
        sendResponse({ error: "Base URL not configured." });
        return;
      }
      await resolveSession(config);
      await chrome.cookies.remove({ url: config.baseUrl, name: "woffu.token" });
      await chrome.tabs.create({ url: `${config.baseUrl}/v2/home`, active: true });
      await log("info", "Manual session renewal: cleared woffu.token and opened Woffu to log in again.");
      sendResponse({ ok: true });
    });
    return true;
  }
  if (request.action === "testNotification") {
    notify(`test-${Date.now()}`, "Woffu: notifications work", "This is how you will be told about registered days or problems.");
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === "autoStatus") {
    (async () => {
      // La caducidad se calcula al vuelo para que se vea aunque aún no haya
      // habido ninguna ejecución (p. ej. con el modo automático desactivado).
      const config = await loadConfig();
      const session = config.baseUrl ? await resolveSession(config) : null;
      const state = await patchState(sessionState(session));
      const logResult = await chrome.storage.local.get(LOG_KEY);
      sendResponse({ state, log: (logResult[LOG_KEY] || []).slice(-15) });
    })();
    return true;
  }
  return false;
});
