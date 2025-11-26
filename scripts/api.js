import { loadConfig } from "./config.js";

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

function pad(num) {
  return String(num).padStart(2, "0");
}

function parseTimeString(timeString) {
  const [hours = "0", minutes = "0", seconds = "0"] = timeString.split(":");
  return {
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: Number(seconds)
  };
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

function buildUtcDate(dateString, timeString, offsetMinutes) {
  const { hours, minutes, seconds } = parseTimeString(timeString);
  const [year, month, day] = dateString.split("-").map(Number);
  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes, seconds) - offsetMinutes * 60 * 1000;
  return new Date(utcMillis).toISOString();
}

function minutesBetween(startTime, endTime) {
  const start = parseTimeString(startTime);
  const end = parseTimeString(endTime);
  return (end.hours * 60 + end.minutes) - (start.hours * 60 + start.minutes);
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

function buildSlotPayload(diary, config) {
  const userId = Number(config.userId);
  const offset = Number(config.utcOffsetMinutes ?? 0);
  
  // Detectar si es viernes (día de la semana 5)
  const date = new Date(diary.date + "T00:00:00");
  const isFriday = date.getDay() === 5;
  
  // Usar slots de viernes si es viernes, sino slots normales
  const slotsToUse = isFriday 
    ? (config.fridaySlots || config.defaultSlots || [])
    : (config.defaultSlots || []);
  
  const slots = slotsToUse
    .filter(slot => slot.start && slot.end)
    .map((slot, index) => {
      const startTime = normalizeTimeValue(slot.start);
      const endTime = normalizeTimeValue(slot.end);
      const inIso = buildUtcDate(diary.date, startTime, offset);
      const outIso = buildUtcDate(diary.date, endTime, offset);
      const totalMinutes = Math.max(minutesBetween(startTime, endTime), 0);
      return {
        id: generateSlotId(diary.date, index),
        in: baseSlotEntry({ dateIso: inIso, time: startTime, signIn: true, userId }),
        out: baseSlotEntry({ dateIso: outIso, time: endTime, signIn: false, userId }),
        motive: null,
        totalMin: totalMinutes
      };
    });

  return {
    userId,
    comments: config.defaultComments || "",
    date: diary.date,
    slots,
    diaryId: diary.diaryId
  };
}

export async function fetchDiarySummary(config, monthValue) {
  const merged = config ?? await loadConfig();
  const baseUrl = sanitizeBaseUrl(merged.baseUrl);
  if (!baseUrl) {
    throw new Error("Configura la URL base antes de cargar datos.");
  }
  if (!merged.userId) {
    throw new Error("Configura el User ID antes de cargar datos.");
  }

  const { from, to } = getMonthBoundaries(monthValue);
  const path = `/api/svc/core/diariesquery/users/${merged.userId}/diaries/summary/presence`;
  const url = new URL(baseUrl + path);
  url.searchParams.set("userId", merged.userId);
  url.searchParams.set("fromDate", from);
  url.searchParams.set("toDate", to);
  url.searchParams.set("pageSize", "31");
  url.searchParams.set("includeHourTypes", "true");
  url.searchParams.set("includeNotHourTypes", "true");
  url.searchParams.set("includeDifference", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildHeaders(ensureToken(merged.bearerToken))
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error al consultar Woffu (${response.status}): ${body}`);
  }

  return response.json();
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
      hasSlots: Array.isArray(diary.slots) && diary.slots.length > 0,
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
    return "No hay datos seleccionados.";
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

  try {
    responseData.body = await response.json();
  } catch (error) {
    responseData.body = await response.text();
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
