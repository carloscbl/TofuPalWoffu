import { loadConfig, saveConfig, createEmptySlot, DEFAULT_CONFIG } from "./config.js";
import {
  fetchDiarySummary,
  findPendingDiaries,
  formatDifference,
  buildPreviewPayloads,
  buildDryRunResponse,
  sendMultipleWorkdaySlots
} from "./api.js";

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

function formatDate(dateString) {
  const date = new Date(dateString + "T00:00:00");
  return date.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short" });
}

function getDefaultMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
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
  form.utcOffset.value = Number.isFinite(config.utcOffsetMinutes) ? config.utcOffsetMinutes : 120;
  form.dryRun.checked = Boolean(config.dryRun);
  renderSlots(config.defaultSlots || [], false);
  renderSlots(config.fridaySlots || [], true);
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
    utcOffsetMinutes: Number(formData.get("utcOffset")) || 0,
    dryRun: formData.get("dryRun") === "on",
    defaultSlots: readSlotsFromForm(slotList),
    fridaySlots: readSlotsFromForm(fridaySlotList)
  };

  await saveConfig(currentConfig);
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
}

async function init() {
  bindEvents();
  monthInput.value = getDefaultMonthValue();
  currentConfig = await loadConfig();
  fillForm(currentConfig);
  
  // Intentar detectar datos del contexto actual
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('.woffu.com')) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "getWoffuData" });
      if (response?.data) {
        let detected = false;
        if (response.data.baseUrl && !currentConfig.baseUrl) {
          form.baseUrl.value = response.data.baseUrl;
          detected = true;
        }
        if (response.data.userId && !currentConfig.userId) {
          form.userId.value = response.data.userId;
          detected = true;
        }
        if (response.data.bearerToken && !currentConfig.bearerToken) {
          form.bearerToken.value = response.data.bearerToken;
          detected = true;
        }
        if (response.data.utcOffset !== null && response.data.utcOffset !== undefined) {
          form.utcOffset.value = response.data.utcOffset;
          detected = true;
        }
        if (detected) {
          await saveCurrentConfig();
          showMessage("Data automatically detected from Woffu.");
        } else {
          showMessage("Configure your data and load the month to see pending days.");
        }
      } else {
        showMessage("Configure your data and load the month to see pending days.");
      }
    } else {
      showMessage("Configure your data and load the month to see pending days.");
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
