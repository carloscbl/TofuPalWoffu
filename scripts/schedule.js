// Lógica pura (sin APIs de Chrome) para decidir qué días registrar y con qué
// bloques. Se comparte entre el popup y el service worker, y se testea con Node.

export function pad(num) {
  return String(num).padStart(2, "0");
}

export function timeToMinutes(timeString) {
  const [hours = "0", minutes = "0"] = String(timeString).split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function minutesToTime(totalMinutes) {
  return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

export function localDateString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  return localDateString(new Date(year, month - 1, day + days));
}

// Convierte una hora local de un día concreto a ISO UTC. Usa la zona horaria
// del sistema, así que el desfase (CET/CEST) es el correcto para *esa* fecha,
// no el del día en que se ejecuta.
export function localToUtcIso(dateString, timeString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hours = "0", minutes = "0", seconds = "0"] = timeString.split(":");
  return new Date(year, month - 1, day, Number(hours), Number(minutes), Number(seconds)).toISOString();
}

// Woffu devuelve duraciones como {resource: "_HoursMinutesFormatted", values: ["8", "30"]}.
export function formattedToMinutes(formatted) {
  if (!formatted || !Array.isArray(formatted.values)) {
    return null;
  }
  const [first = "0", second = "0"] = formatted.values;
  switch (formatted.resource) {
    case "_HoursMinutesFormatted":
      return Number(first) * 60 + Number(second);
    case "_HoursFormatted":
      return Number(first) * 60;
    case "_MinutesFormatted":
      return Number(first);
    default:
      return null;
  }
}

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function isFridayDate(dateString) {
  return new Date(`${dateString}T12:00:00Z`).getUTCDay() === 5;
}

function fallbackSlots(dateString, config) {
  const slots = isFridayDate(dateString)
    ? (config.fridaySlots?.length ? config.fridaySlots : config.defaultSlots)
    : config.defaultSlots;
  return (slots || []).filter(slot => slot.start && slot.end);
}

// Bloques del día según el horario teórico que Woffu asigna a esa fecha
// (`in`, `out`, `breaks`). Así la jornada intensiva de verano, los viernes o
// cualquier día reducido salen solos. Si faltan datos, se usan los bloques
// configurados en el popup.
export function scheduleBlocksForDiary(diary, config) {
  const start = diary?.in ? timeToMinutes(diary.in) : null;
  const end = diary?.out ? timeToMinutes(diary.out) : null;
  const breakMinutes = formattedToMinutes(diary?.breaks);

  const fallback = reason => ({
    source: "config",
    reason,
    slots: fallbackSlots(diary.date.slice(0, 10), config)
  });

  if (start === null || end === null || end <= start) {
    return fallback("Woffu did not return a theoretical schedule");
  }
  if (breakMinutes === null) {
    return fallback("Woffu did not return the break duration");
  }

  let slots;
  if (breakMinutes === 0) {
    slots = [{ start: minutesToTime(start), end: minutesToTime(end) }];
  } else {
    const lunchStart = timeToMinutes(config.lunchStart || "13:00");
    if (lunchStart <= start || lunchStart + breakMinutes >= end) {
      return fallback(`lunch start ${config.lunchStart} does not fit in ${diary.in}-${diary.out}`);
    }
    slots = [
      { start: minutesToTime(start), end: minutesToTime(lunchStart) },
      { start: minutesToTime(lunchStart + breakMinutes), end: minutesToTime(end) }
    ];
  }

  const scheduled = formattedToMinutes(diary.scheduleTimeFormatted);
  const total = end - start - breakMinutes;
  return {
    source: "woffu",
    slots,
    warning: scheduled !== null && scheduled !== total
      ? `blocks total ${minutesToTime(total)} but schedule is ${minutesToTime(scheduled)}`
      : null
  };
}

export function workedMinutes(diary) {
  return formattedToMinutes(diary?.workedTimeFormatted) ?? 0;
}

// Decide si un día puede registrarse de forma desatendida. Es deliberadamente
// conservador: solo días laborables sin ningún tiempo trabajado, porque el PUT
// reemplaza los slots existentes.
export function evaluateAutoFill(diary) {
  if (!diary.isUserEditable) return { ok: false, reason: "not editable" };
  if (diary.isWeekend) return { ok: false, reason: "weekend" };
  if (diary.isHoliday || diary.calendarEvents?.isHoliday) return { ok: false, reason: "holiday" };
  if (hasItems(diary.absenceEvents) || hasItems(diary.pendingAbsenceEvents)) {
    return { ok: false, reason: "absence" };
  }
  if (hasItems(diary.presenceEvents) || hasItems(diary.pendingPresenceEvents)) {
    return { ok: false, reason: "presence request" };
  }
  if (diary.isPending) return { ok: false, reason: "pending approval" };
  if (workedMinutes(diary) > 0) return { ok: false, reason: "already has time" };
  if (Number(diary.differenceTime ?? 0) >= 0) return { ok: false, reason: "nothing missing" };
  return { ok: true };
}

// Último día que ya se puede registrar: hoy si ya pasó la hora de corte, si no ayer.
export function lastDueDate(now, cutoff) {
  const today = localDateString(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= timeToMinutes(cutoff) ? today : addDays(today, -1);
}

export function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// Resume el calendario de Woffu en periodos con el mismo horario, para ver de
// un vistazo cuándo empieza y acaba la jornada de verano y qué bloques se usan.
// Los viernes se agrupan aparte porque suelen tener su propio horario.
export function summarizeSchedulePeriods(diaries, config) {
  const workingDays = diaries
    .filter(diary => !diary.isWeekend && !diary.isHoliday && diary.in && diary.out)
    .sort((a, b) => a.date.localeCompare(b.date));

  const periods = [];
  let current = null;
  for (const diary of workingDays) {
    const date = diary.date.slice(0, 10);
    const kind = isFridayDate(date) ? "friday" : "weekday";
    const schedule = scheduleBlocksForDiary(diary, config);
    const blocks = schedule.slots.map(slot => `${slot.start}-${slot.end}`).join(", ");
    if (!current || (current[kind] && current[kind] !== blocks)) {
      current = { from: date, to: date, weekday: null, friday: null, name: diary.name || null };
      periods.push(current);
    }
    current[kind] = blocks;
    current.to = date;
  }
  return periods;
}
