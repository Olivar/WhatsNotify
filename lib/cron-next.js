'use strict';

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

function nextDailyRun(expression, timezone, from = new Date()) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || fields[2] !== '*' || fields[3] !== '*' || fields[4] !== '*') {
    return null;
  }
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (minute > 59 || hour > 23) return null;

  const start = new Date(from.getTime() + 60_000);
  start.setUTCSeconds(0, 0);
  for (let i = 0; i < 60 * 49; i += 1) {
    const candidate = new Date(start.getTime() + (i * 60_000));
    const p = zonedParts(candidate, timezone);
    if (Number(p.hour) === hour && Number(p.minute) === minute) return candidate.toISOString();
  }
  return null;
}

module.exports = { nextDailyRun };
