import { loadConfig, saveConfig, createEmptySlot, DEFAULT_CONFIG } from "./config.js";
import {
  fetchDiarySummary,
  findPendingDiaries,
  formatDifference,
  buildPreviewPayloads,
  buildDryRunResponse,
  sendMultipleWorkdaySlots,
  fetchDiaryRange
} from "./api.js";
import { summarizeSchedulePeriods } from "./schedule.js";

let currentConfig = { ...DEFAULT_CONFIG };
let pendingDiaries = [];
let selectedDates = new Set();

const form = document.getElementById("config-form");
const slotList = document.getElementById("slot-list");
const addSlotBtn = document.getElementById("add-slot");
const fridaySlotList = document.getElementById("friday-slot-list");
const addFridaySlotBtn = document.getElementById("add-friday-slot");
const monthInput = document.getElementById("month");
const loadButton = document.getElementById("load-month");
const tableBody = document.getElementById("pending-body");
const selectAllCheckbox = document.getElementById("select-all");
const previewSingleBtn = document.getElementById("preview-single");
const previewMultiBtn = document.getElementById("preview-multi");
const sendBtn = document.getElementById("send-selection");
const previewOutput = document.getElementById("preview-output");
const autoForm = document.getElementById("auto-form");
const autoStatus = document.getElementById("auto-status");
const autoLog = document.getElementById("auto-log");
const autoPlanBtn = document.getElementById("auto-plan");
const autoRunBtn = document.getElementById("auto-run");
const healthBanner = document.getElementById("health-banner");
const healthChecks = document.getElementById("health-checks");
const healthCheckBtn = document.getElementById("health-check");
const renewSessionBtn = document.getElementById("renew-session");
const testNotificationBtn = document.getElementById("test-notification");
const calendarYear = document.getElementById("calendar-year");
const loadCalendarBtn = document.getElementById("load-calendar");
const calendarTable = document.getElementById("calendar-table");
const calendarBody = document.getElementById("calendar-body");

function formatDate(dateString) {
  const date = new Date(dateString + "T00:00:00");
  return date.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short" });
}

function getDefaultMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Lee el JWT vigente desde la cookie `woffu.token`. Es la fuente más fiable:
// Woffu guarda ahí el token, y la API chrome.cookies lo lee aunque sea httpOnly.
async function readWoffuTokenCookie(url) {
  if (!url || typeof chrome === "undefined" || !chrome.cookies?.get) {
    return null;
  }
  try {
    const cookie = await chrome.cookies.get({ url, name: "woffu.token" });
    const token = cookie?.value?.trim();
    return token || null;
  } catch (error) {
    console.info("No se pudo leer la cookie woffu.token:", error);
    return null;
  }
}

function createSlotRow(slot, index, parentList) {
  const row = document.createElement("div");
  row.className = "slot-row";

  const startInput = document.createElement("input");
  startInput.type = "time";
  startInput.value = slot.start || "";
  startInput.dataset.role = "start";
  startInput.required = true;

  const endInput = document.createElement("input");
  endInput.type = "time";
  endInput.value = slot.end || "";
  endInput.dataset.role = "end";
  endInput.required = true;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    parentList.removeChild(row);
    if (!parentList.querySelector(".slot-row")) {
      appendSlot(createEmptySlot(), parentList);
    }
  });

  row.append(startInput, endInput, removeBtn);
  return row;
}

function appendSlot(slot, parentList = slotList) {
  const row = createSlotRow(slot, parentList.children.length, parentList);
  parentList.appendChild(row);
}

function renderSlots(slots, isFriday = false) {
  const targetList = isFriday ? fridaySlotList : slotList;
  const defaultSlots = isFriday ? DEFAULT_CONFIG.fridaySlots : DEFAULT_CONFIG.defaultSlots;
  targetList.innerHTML = "";
  (slots.length ? slots : defaultSlots).forEach(slot => appendSlot(slot, targetList));
}

function fillForm(config) {
  form.baseUrl.value = config.baseUrl || "";
  form.userId.value = config.userId || "";
  form.bearerToken.value = config.bearerToken || "";
  form.defaultComments.value = config.defaultComments || "";
  form.dryRun.checked = Boolean(config.dryRun);
  renderSlots(config.defaultSlots || [], false);
  renderSlots(config.fridaySlots || [], true);
  autoForm.autoEnabled.checked = Boolean(config.autoEnabled);
  autoForm.autoCutoff.value = config.autoCutoff || "17:31";
  autoForm.lunchStart.value = config.lunchStart || "13:00";
  autoForm.autoRenew.checked = config.autoRenew !== false;
}

function readSlotsFromForm(parentList = slotList) {
  const rows = parentList.querySelectorAll(".slot-row");
  return Array.from(rows).map(row => ({
    start: row.querySelector('[data-role="start"]').value,
    end: row.querySelector('[data-role="end"]').value
  }));
}

function showMessage(message) {
  previewOutput.textContent = message;
}

function renderPendingTable() {
  tableBody.innerHTML = "";
  selectAllCheckbox.checked = false;
  selectedDates.clear();
  
  if (!pendingDiaries.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "empty";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No pending days for this month.";
    emptyRow.appendChild(cell);
    tableBody.appendChild(emptyRow);
    return;
  }

  // Obtener fecha actual en formato YYYY-MM-DD
  const today = new Date();
  const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  pendingDiaries.forEach(entry => {
    const row = document.createElement("tr");

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    
    // Lógica de selección por defecto:
    // - NO marcar si es el día actual
    // - NO marcar si está en estado "pendiente" (isPending)
    // - SÍ marcar si no tiene bloques (!hasSlots)
    const isToday = entry.date === todayString;
    const shouldCheck = !isToday && !entry.isPending && !entry.hasSlots;
    
    checkbox.checked = shouldCheck;
    checkbox.dataset.date = entry.date;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedDates.add(entry.date);
      } else {
        selectedDates.delete(entry.date);
      }
      const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]');
      const allChecked = Array.from(checkboxes).every(box => box.checked);
      selectAllCheckbox.checked = allChecked;
    });
    
    if (shouldCheck) {
      selectedDates.add(entry.date);
    }
    
    selectCell.appendChild(checkbox);

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(entry.date);
    if (isToday) {
      const todayBadge = document.createElement("span");
      todayBadge.className = "badge success";
      todayBadge.textContent = "Today";
      todayBadge.style.marginLeft = "8px";
      dateCell.appendChild(todayBadge);
    }

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    
    if (entry.isPending) {
      badge.className = "badge warning";
      badge.textContent = "Pending";
    } else if (!entry.hasSlots) {
      badge.className = "badge error";
      badge.textContent = "No blocks";
    } else {
      badge.className = "badge";
      badge.textContent = "No entry";
    }
    
    statusCell.appendChild(badge);

    const diffCell = document.createElement("td");
    diffCell.textContent = formatDifference(entry.differenceTime);

    const actionsCell = document.createElement("td");
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "secondary";
  previewBtn.textContent = "Preview";
    previewBtn.addEventListener("click", () => previewForDates([entry.date]));
    actionsCell.appendChild(previewBtn);

    row.append(selectCell, dateCell, statusCell, diffCell, actionsCell);
    tableBody.appendChild(row);
  });
  
  // Actualizar el estado del checkbox "seleccionar todos"
  const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]');
  if (checkboxes.length > 0) {
    const allChecked = Array.from(checkboxes).every(box => box.checked);
    selectAllCheckbox.checked = allChecked;
  }
}

async function previewForDates(dates) {
  if (!dates.length) {
    showMessage("Select at least one day.");
    return;
  }
  const payloads = buildPreviewPayloads(pendingDiaries, currentConfig, dates);
  const dryRun = buildDryRunResponse(payloads, currentConfig);
  previewOutput.textContent = JSON.stringify(dryRun, null, 2);
  console.info("[TofuPalWoffu] Previsualizacion:", dryRun);
}

async function saveCurrentConfig() {
  const formData = new FormData(form);
  currentConfig = {
    ...currentConfig,
    baseUrl: formData.get("baseUrl")?.trim() ?? "",
    userId: formData.get("userId")?.toString().trim() ?? "",
    bearerToken: formData.get("bearerToken")?.trim() ?? "",
    defaultComments: formData.get("defaultComments")?.trim() ?? "",
    dryRun: formData.get("dryRun") === "on",
    defaultSlots: readSlotsFromForm(slotList),
    fridaySlots: readSlotsFromForm(fridaySlotList),
    autoEnabled: autoForm.autoEnabled.checked,
    autoCutoff: autoForm.autoCutoff.value || "17:31",
    lunchStart: autoForm.lunchStart.value || "13:00",
    autoRenew: autoForm.autoRenew.checked
  };

  await saveConfig(currentConfig);
}

// ---------------------------------------------------------------------------
// Modo automático (lo ejecuta el service worker; aquí solo se muestra/controla)
// ---------------------------------------------------------------------------

function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

function formatDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

async function refreshAutoStatus() {
  const { state = {}, log = [] } = await sendToBackground({ action: "autoStatus" }) || {};
  const lines = [];
  lines.push(`Last run: ${formatDateTime(state.lastRunAt)}${state.lastTrigger ? ` (${state.lastTrigger})` : ""}`);
  if (state.lastResult) {
    const { registered, failed, pending } = state.lastResult;
    lines.push(`Result: ${registered} registered, ${failed} failed, ${pending} due`);
  }
  autoStatus.innerHTML = lines.join("<br>");
  autoLog.textContent = log
    .map(entry => `${new Date(entry.ts).toLocaleString()}  ${entry.level === "error" ? "✗" : "·"} ${entry.message}`)
    .reverse()
    .join("\n");
}

const HEALTH_LABELS = {
  ok: "● Automatic registration is working",
  warning: "● Working, but needs attention",
  error: "● Automatic registration is NOT working"
};

async function runHealthCheck() {
  healthCheckBtn.disabled = true;
  healthBanner.className = "health-banner unknown";
  healthBanner.textContent = "Checking…";
  try {
    const result = await sendToBackground({ action: "autoHealth" });
    healthBanner.className = `health-banner ${result.level}`;
    healthBanner.textContent = result.error ? `● Check failed: ${result.error}` : HEALTH_LABELS[result.level];
    healthChecks.innerHTML = "";
    for (const check of result.checks || []) {
      const item = document.createElement("li");
      item.className = `level-${check.level}`;
      const name = document.createElement("strong");
      name.textContent = `${check.name}: `;
      item.append(name, check.detail);
      healthChecks.appendChild(item);
    }
    const sessionCheck = (result.checks || []).find(check => check.name === "Woffu session");
    renewSessionBtn.classList.toggle("primary", sessionCheck?.level !== "ok");
    renewSessionBtn.classList.toggle("secondary", sessionCheck?.level === "ok");
  } finally {
    healthCheckBtn.disabled = false;
  }
}

async function handleRenewSession() {
  await sendToBackground({ action: "renewNow" });
  showMessage("The Woffu session cookie was cleared and Woffu opened in a new tab to log in again (your current token is kept until it expires). Complete the Microsoft login if asked; the new token is picked up automatically. Then reopen this popup and press “Check now”.");
}

async function saveAutoSettings() {
  await saveCurrentConfig();
  await sendToBackground({ action: "autoSettingsChanged" });
  await refreshAutoStatus();
  await runHealthCheck();
}

async function handleAutoPlan() {
  autoPlanBtn.disabled = true;
  try {
    await saveCurrentConfig();
    const result = await sendToBackground({ action: "autoPlan" });
    if (result?.error) {
      showMessage(`Simulation failed: ${result.error}`);
    } else if (!result?.days?.length) {
      showMessage(`Nothing to register between ${result.range.from} and ${result.range.to}.`);
    } else {
      showMessage(
        `Would register ${result.days.length} day(s) (up to ${result.range.to}):\n\n` +
        result.days
          .map(day => `${day.date}  ${day.blocks}  [${day.source}]${day.note ? `  ⚠ ${day.note}` : ""}`)
          .join("\n")
      );
    }
    await refreshAutoStatus();
  } finally {
    autoPlanBtn.disabled = false;
  }
}

function formatShortDate(dateString) {
  return new Date(`${dateString}T12:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

async function handleLoadCalendar() {
  const year = Number(calendarYear.value) || new Date().getFullYear();
  loadCalendarBtn.disabled = true;
  loadCalendarBtn.textContent = "Loading...";
  try {
    const diaries = [];
    for (let month = 1; month <= 12; month++) {
      const from = `${year}-${String(month).padStart(2, "0")}-01`;
      const last = new Date(year, month, 0).getDate();
      const to = `${year}-${String(month).padStart(2, "0")}-${last}`;
      const summary = await fetchDiaryRange(currentConfig, from, to);
      diaries.push(...(summary.diaries || []));
    }
    const periods = summarizeSchedulePeriods(diaries, currentConfig);
    calendarBody.innerHTML = "";
    for (const period of periods) {
      const row = document.createElement("tr");
      const isSingleBlock = period.weekday && !period.weekday.includes(",");
      if (isSingleBlock) {
        row.className = "single";
      }
      const cells = [
        `${formatShortDate(period.from)} – ${formatShortDate(period.to)}${isSingleBlock ? " ☀" : ""}`,
        period.weekday || "—",
        period.friday || "—"
      ];
      for (const text of cells) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.appendChild(cell);
      }
      calendarBody.appendChild(row);
    }
    calendarTable.hidden = periods.length === 0;
    if (!periods.length) {
      showMessage(`Woffu returned no schedule for ${year}.`);
    }
  } catch (error) {
    showMessage(`Could not load the schedule: ${error.message}`);
  } finally {
    loadCalendarBtn.disabled = false;
    loadCalendarBtn.textContent = "Load schedule";
  }
}

async function handleAutoRun() {
  if (!confirm("Register now every due working day that is still empty?")) {
    return;
  }
  autoRunBtn.disabled = true;
  autoRunBtn.textContent = "Running...";
  try {
    await saveCurrentConfig();
    const result = await sendToBackground({ action: "autoRun" });
    showMessage(JSON.stringify(result, null, 2));
    await runHealthCheck();
    await refreshAutoStatus();
  } finally {
    autoRunBtn.disabled = false;
    autoRunBtn.textContent = "Run now";
  }
}

function setupAutoSave() {
  // Guardar automáticamente cuando cambien los campos de texto
  const textInputs = form.querySelectorAll('input[type="url"], input[type="number"], input[type="text"], textarea');
  textInputs.forEach(input => {
    input.addEventListener("blur", saveCurrentConfig);
  });

  // Guardar automáticamente al cambiar el checkbox
  form.dryRun.addEventListener("change", saveCurrentConfig);

  // Guardar al cambiar slots (tiempo de espera para evitar múltiples guardados)
  let slotSaveTimeout;
  const saveSlots = () => {
    clearTimeout(slotSaveTimeout);
    slotSaveTimeout = setTimeout(saveCurrentConfig, 500);
  };

  // Observer para detectar cambios en los slots (ambas listas)
  const observerCallback = (list) => () => {
    const timeInputs = list.querySelectorAll('input[type="time"]');
    timeInputs.forEach(input => {
      input.removeEventListener("change", saveSlots);
      input.addEventListener("change", saveSlots);
    });
  };

  const slotObserver = new MutationObserver(observerCallback(slotList));
  slotObserver.observe(slotList, { childList: true, subtree: true });

  const fridayObserver = new MutationObserver(observerCallback(fridaySlotList));
  fridayObserver.observe(fridaySlotList, { childList: true, subtree: true });

  // Inicializar eventos en slots existentes
  [slotList, fridaySlotList].forEach(list => {
    const timeInputs = list.querySelectorAll('input[type="time"]');
    timeInputs.forEach(input => {
      input.addEventListener("change", saveSlots);
    });
  });
}

async function handleLoadMonth() {
  const monthValue = monthInput.value || getDefaultMonthValue();
  try {
    loadButton.disabled = true;
    loadButton.textContent = "Loading...";
    const summary = await fetchDiarySummary(currentConfig, monthValue);
    pendingDiaries = findPendingDiaries(summary);
    selectedDates.clear(); // Limpiar selección anterior
    renderPendingTable();
    showMessage("Select days and generate preview before sending.");
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Could not load month.");
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = "Load records";
  }
}

function handleSelectAll(event) {
  const checked = event.target.checked;
  const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]');
  selectedDates = new Set();
  checkboxes.forEach(box => {
    box.checked = checked;
    if (checked) {
      selectedDates.add(box.dataset.date);
    }
  });
}

function handlePreviewSingle() {
  if (!selectedDates.size) {
  showMessage("Select at least one pending day.");
    return;
  }
  const [firstDate] = Array.from(selectedDates).sort();
  previewForDates([firstDate]);
}

function handlePreviewMulti() {
  if (!selectedDates.size) {
  showMessage("Select at least one pending day.");
    return;
  }
  previewForDates(Array.from(selectedDates).sort());
}

async function handleSendSelection() {
  if (!selectedDates.size) {
    showMessage("Select at least one pending day to send.");
    return;
  }

  const dates = Array.from(selectedDates).sort();
  const payloads = buildPreviewPayloads(pendingDiaries, currentConfig, dates);
  
  if (!payloads.length) {
    showMessage("No valid data to send.");
    return;
  }

  // Mostrar confirmación
  const confirmMessage = `Confirm sending ${payloads.length} day(s)?\n\n` +
    payloads.map(p => `• ${p.date} (${p.slots.length} blocks)`).join('\n') +
    `\n\nThis will send the time entries to Woffu.`;
  
  if (!confirm(confirmMessage)) {
    showMessage("Send cancelled.");
    return;
  }

  // Mostrar preview antes de enviar
  const previewData = buildDryRunResponse(payloads, currentConfig);
  previewOutput.textContent = "Sending...\n\n" + JSON.stringify(previewData, null, 2);
  
  try {
    sendBtn.disabled = true;
    sendBtn.textContent = "Enviando...";
    
    const results = await sendMultipleWorkdaySlots(payloads, currentConfig);
    
    // Mostrar resultados
    const summary = {
      total: results.length,
      successful: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results: results.map(r => ({
        date: r.date,
        status: r.ok ? "✓ Success" : "✗ Failed",
        code: r.status,
        message: r.statusText,
        error: r.error,
        response: r.body
      }))
    };
    
    previewOutput.textContent = JSON.stringify(summary, null, 2);
    
    // Recargar datos después de 2 segundos
    setTimeout(async () => {
      showMessage("Reloading records...");
      await handleLoadMonth();
    }, 2000);
    
  } catch (error) {
    console.error(error);
    showMessage(`Error sending: ${error.message}`);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send selection";
  }
}

function bindEvents() {
  setupAutoSave();
  addSlotBtn.addEventListener("click", () => appendSlot(createEmptySlot(), slotList));
  addFridaySlotBtn.addEventListener("click", () => appendSlot(createEmptySlot(), fridaySlotList));
  loadButton.addEventListener("click", handleLoadMonth);
  selectAllCheckbox.addEventListener("change", handleSelectAll);
  previewSingleBtn.addEventListener("click", handlePreviewSingle);
  previewMultiBtn.addEventListener("click", handlePreviewMulti);
  sendBtn.addEventListener("click", handleSendSelection);
  autoForm.querySelectorAll("input").forEach(input => input.addEventListener("change", saveAutoSettings));
  autoPlanBtn.addEventListener("click", handleAutoPlan);
  autoRunBtn.addEventListener("click", handleAutoRun);
  loadCalendarBtn.addEventListener("click", handleLoadCalendar);
  healthCheckBtn.addEventListener("click", () => runHealthCheck().then(refreshAutoStatus));
  renewSessionBtn.addEventListener("click", handleRenewSession);
  testNotificationBtn.addEventListener("click", () => sendToBackground({ action: "testNotification" }));
}

async function init() {
  bindEvents();
  monthInput.value = getDefaultMonthValue();
  calendarYear.value = new Date().getFullYear();
  currentConfig = await loadConfig();
  fillForm(currentConfig);
  runHealthCheck()
    .then(refreshAutoStatus)
    .catch(error => console.info("Could not load automatic mode status:", error));
  
  // Intentar detectar datos del contexto actual
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('.woffu.com')) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "getWoffuData" });
      const data = response?.data ?? {};
      let detected = false;

      if (data.baseUrl && !currentConfig.baseUrl) {
        form.baseUrl.value = data.baseUrl;
        detected = true;
      }
      if (data.userId && !currentConfig.userId) {
        form.userId.value = data.userId;
        detected = true;
      }

      // El token caduca cada ~90 días, así que SIEMPRE lo refrescamos desde la
      // cookie vigente (no solo cuando está vacío). La cookie es la fuente real.
      const tabBaseUrl = form.baseUrl.value || `${new URL(tab.url).protocol}//${new URL(tab.url).hostname}`;
      const cookieToken = await readWoffuTokenCookie(tabBaseUrl);
      const freshToken = cookieToken || data.bearerToken;
      if (freshToken && freshToken !== currentConfig.bearerToken) {
        form.bearerToken.value = freshToken;
        detected = true;
      }

      if (detected) {
        await saveCurrentConfig();
        showMessage("Data automatically detected from Woffu.");
      } else {
        showMessage("Configure your data and load the month to see pending days.");
      }
    } else {
      showMessage("Open a Woffu tab to auto-detect your session, then load the month.");
    }
  } catch (error) {
    // Si no se puede detectar, no pasa nada
    console.info("Could not detect data automatically:", error);
    showMessage("Configure your data and load the month to see pending days.");
  }
}

init().catch(error => {
  console.error(error);
  showMessage("Could not initialize the extension.");
});
