const STORAGE_KEY = "woffuConfig";

export const DEFAULT_CONFIG = {
  baseUrl: "",
  userId: "",
  bearerToken: "",
  defaultComments: "",
  defaultSlots: [
    { start: "08:00", end: "13:00" },
    { start: "14:00", end: "17:30" }
  ],
  fridaySlots: [
    { start: "08:00", end: "15:00" }
  ],
  utcOffsetMinutes: 120,
  dryRun: true
};

function isExtensionContext() {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

function mergeConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CONFIG };
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    defaultSlots: Array.isArray(raw.defaultSlots) && raw.defaultSlots.length > 0
      ? raw.defaultSlots.map(slot => ({ start: slot.start ?? "", end: slot.end ?? "" }))
      : [...DEFAULT_CONFIG.defaultSlots],
    fridaySlots: Array.isArray(raw.fridaySlots) && raw.fridaySlots.length > 0
      ? raw.fridaySlots.map(slot => ({ start: slot.start ?? "", end: slot.end ?? "" }))
      : [...DEFAULT_CONFIG.fridaySlots]
  };
}

export async function loadConfig() {
  if (isExtensionContext()) {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY], result => {
        resolve(mergeConfig(result[STORAGE_KEY]));
      });
    });
  }
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    return mergeConfig(cached ? JSON.parse(cached) : undefined);
  } catch (error) {
    console.warn("No se pudo leer la configuración local:", error);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  const sanitized = mergeConfig(config);
  if (isExtensionContext()) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [STORAGE_KEY]: sanitized }, () => resolve(sanitized));
    });
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (error) {
    console.warn("No se pudo guardar la configuración local:", error);
  }
  return sanitized;
}

export function createEmptySlot() {
  return { start: "09:00", end: "17:00" };
}
