// Ejecutar con: TZ=Europe/Madrid node --test tests/schedule.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleBlocksForDiary,
  evaluateAutoFill,
  localToUtcIso,
  lastDueDate,
  addDays,
  decodeJwtPayload,
  summarizeSchedulePeriods
} from "../scripts/schedule.js";

const config = {
  lunchStart: "13:00",
  defaultSlots: [{ start: "08:00", end: "13:00" }, { start: "14:00", end: "17:30" }],
  fridaySlots: [{ start: "08:00", end: "15:00" }]
};

const hours = (...values) => ({ resource: values.length > 1 ? "_HoursMinutesFormatted" : "_HoursFormatted", values });

// Día laborable vacío tal y como lo devuelve diaries/summary/presence.
function emptyDay(overrides = {}) {
  return {
    diaryId: 1,
    diarySummaryId: 2,
    date: "2025-10-02",
    isWeekend: false,
    isHoliday: false,
    isUserEditable: true,
    isPending: false,
    differenceTime: -30600,
    absenceEvents: null,
    pendingAbsenceEvents: null,
    presenceEvents: null,
    pendingPresenceEvents: null,
    calendarEvents: { isHoliday: false },
    in: "08:00:00",
    out: "17:30:00",
    breaks: hours("1"),
    workedTimeFormatted: hours("0"),
    scheduleTimeFormatted: hours("8", "30"),
    ...overrides
  };
}

test("split day uses Woffu schedule and the configured lunch start", () => {
  const result = scheduleBlocksForDiary(emptyDay(), config);
  assert.equal(result.source, "woffu");
  assert.deepEqual(result.slots, [{ start: "08:00", end: "13:00" }, { start: "14:00", end: "17:30" }]);
  assert.equal(result.warning, null);
});

test("Friday / summer intensive day (no break) is a single block", () => {
  const summer = emptyDay({ date: "2026-07-15", out: "15:00:00", breaks: hours("0"), scheduleTimeFormatted: hours("7") });
  const result = scheduleBlocksForDiary(summer, config);
  assert.deepEqual(result.slots, [{ start: "08:00", end: "15:00" }]);
  assert.equal(result.warning, null);
});

test("falls back to configured blocks when Woffu has no schedule", () => {
  const friday = emptyDay({ date: "2025-10-10", in: "", out: "", breaks: null });
  const result = scheduleBlocksForDiary(friday, config);
  assert.equal(result.source, "config");
  assert.deepEqual(result.slots, config.fridaySlots);
});

test("warns when blocks do not add up to the scheduled time", () => {
  const odd = emptyDay({ scheduleTimeFormatted: hours("8") });
  assert.match(scheduleBlocksForDiary(odd, config).warning, /08:30.*08:00/);
});

test("only empty, editable working days are auto-filled", () => {
  assert.deepEqual(evaluateAutoFill(emptyDay()), { ok: true });
  const cases = {
    weekend: { isWeekend: true },
    holiday: { isHoliday: true, differenceTime: 0 },
    absence: { absenceEvents: [{ allDay: true }], differenceTime: 0 },
    "presence request": { pendingPresenceEvents: 1 },
    "pending approval": { isPending: true },
    "already has time": { workedTimeFormatted: hours("4", "15"), differenceTime: -15300 },
    "nothing missing": { differenceTime: 0 },
    "not editable": { isUserEditable: false }
  };
  for (const [reason, overrides] of Object.entries(cases)) {
    assert.equal(evaluateAutoFill(emptyDay(overrides)).reason, reason, reason);
  }
});

test("UTC conversion uses the offset of each date (DST ends 2026-10-25)", () => {
  assert.equal(localToUtcIso("2026-10-23", "08:00:00"), "2026-10-23T06:00:00.000Z");
  assert.equal(localToUtcIso("2026-10-26", "08:00:00"), "2026-10-26T07:00:00.000Z");
  assert.equal(localToUtcIso("2026-07-15", "15:00:00"), "2026-07-15T13:00:00.000Z");
});

test("today is due only after the cutoff", () => {
  assert.equal(lastDueDate(new Date(2026, 9, 13, 17, 30), "17:31"), "2026-10-12");
  assert.equal(lastDueDate(new Date(2026, 9, 13, 17, 31), "17:31"), "2026-10-13");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("decodes JWT payloads with base64url characters", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1784533613, UserId: 42, n: "ñ?>" })).toString("base64url");
  assert.deepEqual(decodeJwtPayload(`x.${payload}.y`).UserId, 42);
  assert.equal(decodeJwtPayload("garbage"), null);
});

test("summarizes the calendar into periods (summer intensive schedule)", () => {
  const day = (date, out, breakHours) => emptyDay({ date, out, breaks: hours(breakHours), scheduleTimeFormatted: null });
  const diaries = [
    day("2026-06-18", "17:30:00", "1"),           // jueves normal
    day("2026-06-19", "15:00:00", "0"),           // viernes
    emptyDay({ date: "2026-06-20", isWeekend: true }),
    day("2026-06-22", "15:00:00", "0"),           // empieza verano
    day("2026-06-26", "15:00:00", "0"),
    emptyDay({ date: "2026-08-14", isHoliday: true, in: "", out: "" }),
    day("2026-09-10", "15:00:00", "0"),
    day("2026-09-14", "17:30:00", "1")            // vuelve la jornada partida
  ];
  assert.deepEqual(
    summarizeSchedulePeriods(diaries, config).map(({ from, to, weekday, friday }) => ({ from, to, weekday, friday })),
    [
      { from: "2026-06-18", to: "2026-06-19", weekday: "08:00-13:00, 14:00-17:30", friday: "08:00-15:00" },
      { from: "2026-06-22", to: "2026-09-10", weekday: "08:00-15:00", friday: "08:00-15:00" },
      { from: "2026-09-14", to: "2026-09-14", weekday: "08:00-13:00, 14:00-17:30", friday: null }
    ]
  );
});
