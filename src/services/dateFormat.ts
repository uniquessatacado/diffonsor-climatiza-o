type DateValue = string | Date | null | undefined;

export type BrazilianDateFormatOptions = {
  fallback?: string;
  timeZone?: string;
  includeSeconds?: boolean;
};

type CalendarParts = { year: string; month: string; day: string; time?: string };

function validCalendarDate(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(match && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])));
}

/** Formats typing/pasting only; calendar validity is checked separately. */
export function maskBrazilianDate(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("/");
}

/** Converts a complete Brazilian calendar date to the existing ISO date-only payload. */
export function parseBrazilianDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidIsoDate(iso) ? iso : null;
}

function instantParts(value: Date, options: BrazilianDateFormatOptions): CalendarParts | null {
  if (Number.isNaN(value.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("pt-BR", {
      calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const year = read("year").padStart(4, "0");
    const month = read("month");
    const day = read("day");
    if (!validCalendarDate(Number(year), Number(month), Number(day))) return null;
    return { year, month, day, time: `${read("hour")}:${read("minute")}${options.includeSeconds ? `:${read("second")}` : ""}` };
  } catch {
    return null;
  }
}

function calendarParts(value: DateValue, options: BrazilianDateFormatOptions): CalendarParts | null {
  if (value instanceof Date) return instantParts(value, options);
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  // Date-only values and backend wall-clock dates are calendar values, not UTC instants.
  // Parsing their components avoids the previous-day shift caused by new Date("YYYY-MM-DD").
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T,]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!iso && !brazilian) return null;
  const year = iso?.[1] ?? brazilian![3];
  const month = iso?.[2] ?? brazilian![2];
  const day = iso?.[3] ?? brazilian![1];
  const hour = iso?.[4] ?? brazilian?.[4];
  const minute = iso?.[5] ?? brazilian?.[5];
  const second = iso?.[6] ?? brazilian?.[6] ?? "00";
  if (!validCalendarDate(Number(year), Number(month), Number(day))) return null;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return null;
  if (iso?.[7]) return instantParts(new Date(text.replace(" ", "T")), options);
  return {
    year, month, day,
    ...(hour !== undefined ? { time: `${hour}:${minute}${options.includeSeconds ? `:${second}` : ""}` } : {}),
  };
}

export function formatBrazilianDate(value: DateValue, options: BrazilianDateFormatOptions = {}): string {
  const parts = calendarParts(value, options);
  return parts ? `${parts.day}/${parts.month}/${parts.year}` : options.fallback ?? "Não informado";
}

export function formatBrazilianDateTime(value: DateValue, options: BrazilianDateFormatOptions = {}): string {
  const parts = calendarParts(value, options);
  if (!parts) return options.fallback ?? "Não informado";
  return `${parts.day}/${parts.month}/${parts.year}${parts.time ? ` ${parts.time}` : ""}`;
}
