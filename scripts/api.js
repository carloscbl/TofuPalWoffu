import { loadConfig } from "./config.js";
import {
  pad,
  timeToMinutes,
  localToUtcIso,
  scheduleBlocksForDiary,
  workedMinutes
} from "./schedule.js";

function sanitizeBaseUrl(baseUrl) {
  return (baseUrl || "").trim().replace(/\/$/, "");
}

function ensureToken(token) {
  return (token || "").trim();
}

function buildHeaders(token) {
  const headers = new Headers();
  headers.set("accept", "application/json, text/plain, */*");
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("content-type", "application/json");
  return headers;
}

function getMonthBoundaries(monthValue) {
  const [year, month] = monthValue.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const fmt = (date) => date.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

function normalizeTimeValue(timeString) {
  if (!timeString) {
    return "00:00:00";
  }
  const [hours = "0", minutes = "0", seconds] = timeString.split(":");
  const normalizedHours = pad(Number(hours));
  const normalizedMinutes = pad(Number(minutes));
  if (typeof seconds !== "undefined") {
    return `${normalizedHours}:${normalizedMinutes}:${pad(Number(seconds))}`;
  }
  return `${normalizedHours}:${normalizedMinutes}:00`;
}

function baseSlotEntry({
  dateIso,
  time,
  signIn,
  userId
}) {
  return {
    signId: 0,
    userId,
    date: dateIso,
    trueDate: dateIso,
    signIn,
    ip: null,
    latitude: null,
    longitude: null,
    outside: null,
    time,
    valueTime: time,
    shortTime: time,
    shortTrueTime: time,
    shortValueTime: time,
    utcTime: `${time} +0`,
    code: null,
    signType: 3,
    signStatus: 1,
    signEventId: null,
    deviceId: null,
    deviceType: 0,
    deleted: false,
    updatedOn: null,
    requestId: null,
    agreementEventId: null
  };
}

function generateSlotId(date, index) {
  const stamp = Date.now().toString(36);
  return `${date}-${index}-${stamp}`;
}

export function buildSlotPayload(diary, config) {
  const userId = Number(config.userId);
  const date = diary.date.slice(0, 10);

  // Bloques según el horario que Woffu asigna a ese día (verano, viernes…),
  // con los bloques configurados como respaldo.
  const schedule = scheduleBlocksForDiary(diary, config);

  const slots = schedule.slots.map((slot, index) => {
    const startTime = normalizeTimeValue(slot.start);
    const endTime = normalizeTimeValue(slot.end);
    return {
      id: generateSlotId(date, index),
      in: baseSlotEntry({ dateIso: localToUtcIso(date, startTime), time: startTime, signIn: true, userId }),
      out: baseSlotEntry({ dateIso: localToUtcIso(date, endTime), time: endTime, signIn: false, userId }),
      motive: null,
      totalMin: Math.max(timeToMinutes(endTime) - timeToMinutes(startTime), 0)
    };
  });

  return {
    userId,
    comments: config.defaultComments || "",
    date,
    slots,
    diaryId: diary.diaryId
  };
}

export async function fetchDiaryRange(config, from, to) {
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error("Configure the base URL before loading data.");
  }
  if (!config.userId) {
    throw new Error("Configure the User ID before loading data.");
  }

  const path = `/api/svc/core/diariesquery/users/${config.userId}/diaries/summary/presence`;
  const url = new URL(baseUrl + path);
  url.searchParams.set("userId", config.userId);
  url.searchParams.set("fromDate", from);
  url.searchParams.set("toDate", to);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("includeHourTypes", "true");
  url.searchParams.set("includeNotHourTypes", "true");
  url.searchParams.set("includeDifference", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildHeaders(ensureToken(config.bearerToken))
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Error querying Woffu (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Comprobación de última hora antes de un PUT: cuántos fichajes reales tiene
// ya el día. Este endpoint también devuelve los bloques *propuestos* según el
// horario teórico (los que la web precarga al editar), así que solo cuentan
// los slots con un fichaje guardado (signId asignado). Devuelve null si la
// respuesta no tiene un formato reconocible.
export async function fetchExistingSlotCount(config, diarySummaryId) {
  if (!diarySummaryId) {
    return null;
  }
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  const response = await fetch(
    `${baseUrl}/api/svc/core/diariesquery/diarysummaries/${diarySummaryId}/workday/slots/self`,
    { method: "GET", headers: buildHeaders(ensureToken(config.bearerToken)) }
  );
  if (!response.ok) {
    return null;
  }
  const body = await response.json().catch(() => null);
  const slots = Array.isArray(body) ? body : body?.slots;
  if (!Array.isArray(slots)) {
    return null;
  }
  return slots.filter(isSavedSlot).length;
}

function isSavedSign(sign) {
  const signId = Number(sign?.signId ?? sign?.SignId ?? 0);
  return signId > 0 && !(sign.deleted ?? sign.Deleted);
}

export function isSavedSlot(slot) {
  return isSavedSign(slot?.in) || isSavedSign(slot?.out);
}

export async function fetchDiarySummary(config, monthValue) {
  const merged = config ?? await loadConfig();
  const { from, to } = getMonthBoundaries(monthValue);
  return fetchDiaryRange(merged, from, to);
}

export function findPendingDiaries(summary) {
  if (!summary || !Array.isArray(summary.diaries)) {
    return [];
  }

  return summary.diaries
    .filter(diary => {
      if (!diary.isUserEditable) {
        return false;
      }
      if (diary.isWeekend || diary.isHoliday) {
        return false;
      }
      if (Array.isArray(diary.absenceEvents) && diary.absenceEvents.length > 0) {
        return false;
      }
      if (diary.pendingPresenceEvents || diary.pendingAbsenceEvents) {
        return true;
      }
      const difference = Number(diary.differenceTime ?? 0);
      return difference < 0;
    })
    .map(diary => ({
      diaryId: diary.diaryId,
      date: diary.date,
      differenceTime: Number(diary.differenceTime ?? 0),
      isPending: Boolean(diary.isPending),
      hasSlots: workedMinutes(diary) > 0,
      workedTimeFormatted: diary.workedTimeFormatted,
      name: diary.name,
      raw: diary
    }));
}

export function formatDifference(minutes) {
  const totalMinutes = Number(minutes);
  const sign = totalMinutes >= 0 ? 1 : -1;
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 3600);
  const minutesRemainder = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  const parts = [
    `${sign < 0 ? "-" : ""}${pad(hours)}`,
    pad(minutesRemainder),
    pad(seconds)
  ];
  return parts.join(":");
}

export function buildPreviewPayloads(diaries, config, dates) {
  const diaryMap = new Map(diaries.map(d => [d.date, d.raw]));
  const selected = dates.filter(date => diaryMap.has(date));
  return selected.map(date => buildSlotPayload(diaryMap.get(date), config));
}

export function toPreviewString(payloads) {
  if (!payloads.length) {
    return "No data selected.";
  }
  if (payloads.length === 1) {
    return JSON.stringify(payloads[0], null, 2);
  }
  return JSON.stringify(payloads, null, 2);
}

export function buildDryRunResponse(payloads, config) {
  return {
    dryRun: Boolean(config.dryRun),
    endpoint: payloads.length
      ? `${sanitizeBaseUrl(config.baseUrl)}/api/diaries/{diaryId}/workday/slots/self`
      : null,
    payloads,
    timestamp: new Date().toISOString()
  };
}

export async function sendWorkdaySlots(payload, config) {
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  const diaryId = payload.diaryId;
  const endpoint = `${baseUrl}/api/diaries/${diaryId}/workday/slots/self`;
  
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: buildHeaders(ensureToken(config.bearerToken)),
    body: JSON.stringify(payload)
  });

  const responseData = {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    date: payload.date,
    diaryId: payload.diaryId
  };

  // El cuerpo solo se puede leer una vez, y Woffu responde 204 sin cuerpo al
  // guardar: se lee como texto y se intenta interpretar como JSON.
  const text = await response.text().catch(() => "");
  try {
    responseData.body = text ? JSON.parse(text) : null;
  } catch {
    responseData.body = text;
  }

  return responseData;
}

export async function sendMultipleWorkdaySlots(payloads, config) {
  const results = [];
  
  for (const payload of payloads) {
    try {
      const result = await sendWorkdaySlots(payload, config);
      results.push(result);
      
      // Pequeña pausa entre requests para no saturar el servidor
      if (payloads.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      results.push({
        status: 0,
        statusText: "Error",
        ok: false,
        date: payload.date,
        diaryId: payload.diaryId,
        error: error.message
      });
    }
  }
  
  return results;
}
