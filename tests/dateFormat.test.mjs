import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/services/dateFormat.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { formatBrazilianDate, formatBrazilianDateTime, isValidIsoDate, maskBrazilianDate, parseBrazilianDate } =
  await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("ISO date-only values retain their calendar day in all time zones", () => {
  for (const timeZone of ["America/Sao_Paulo", "Pacific/Honolulu", "Pacific/Kiritimati", "UTC"]) {
    assert.equal(formatBrazilianDate("2026-09-21", { timeZone }), "21/09/2026");
    assert.equal(formatBrazilianDateTime("2026-09-21", { timeZone }), "21/09/2026");
  }
});

test("backend wall-clock datetime values are displayed literally without assigning a timezone", () => {
  for (const value of ["2026-09-21 00:15:30", "2026-09-21T00:15:30.123", "21/09/2026 00:15:30"]) {
    assert.equal(formatBrazilianDateTime(value, { timeZone: "America/Sao_Paulo" }), "21/09/2026 00:15");
    assert.equal(formatBrazilianDateTime(value, { includeSeconds: true }), "21/09/2026 00:15:30");
  }
});

test("timestamps with timezone offsets convert the actual instant to the user's timezone", () => {
  assert.equal(formatBrazilianDateTime("2026-09-21T01:30:00Z", { timeZone: "America/Sao_Paulo" }), "20/09/2026 22:30");
  assert.equal(formatBrazilianDate("2026-09-21T01:30:00Z", { timeZone: "America/Sao_Paulo" }), "20/09/2026");
  assert.equal(formatBrazilianDateTime("2026-09-21T01:30:00-03:00", { timeZone: "UTC" }), "21/09/2026 04:30");
  assert.equal(formatBrazilianDateTime(new Date("2026-09-21T00:00:00Z"), { timeZone: "UTC" }), "21/09/2026 00:00");
});

test("zero, invalid, overflowing and unrecognized dates never render Invalid Date or a normalized wrong day", () => {
  for (const value of [null, undefined, "", "0000-00-00", "0000-00-00 00:00:00", "2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "21/13/2026", "2026-09-21T25:00:00Z", "2026-09-21 12:60:00", "2026-09-21T12:00:60Z", "2026-02-29T01:00:00Z", "not-a-date", new Date(NaN)]) {
    assert.equal(formatBrazilianDate(value), "Não informado", String(value));
    assert.equal(formatBrazilianDateTime(value, { fallback: "—" }), "—", String(value));
  }
});

test("leap years, four-digit years and dates already in Brazilian notation are validated correctly", () => {
  assert.equal(formatBrazilianDate("2000-02-29"), "29/02/2000");
  assert.equal(formatBrazilianDate("1900-02-29"), "Não informado");
  assert.equal(formatBrazilianDate("2024-02-29"), "29/02/2024");
  assert.equal(formatBrazilianDate("0099-01-02"), "02/01/0099");
  assert.equal(formatBrazilianDate("21/09/2026"), "21/09/2026");
});

test("Brazilian typing/pasting is masked consistently without changing day/month order", () => {
  const examples = [["", ""], ["2", "2"], ["21", "21"], ["210", "21/0"], ["2109", "21/09"],
    ["21092", "21/09/2"], ["21092026", "21/09/2026"], ["21/09/2026", "21/09/2026"],
    ["21.09.2026", "21/09/2026"], ["21092026000", "21/09/2026"]];
  for (const [value, expected] of examples) assert.equal(maskBrazilianDate(value), expected);
});

test("valid Brazilian input becomes ISO payload while partial or impossible values are rejected", () => {
  assert.equal(parseBrazilianDate("21/09/2026"), "2026-09-21");
  assert.equal(parseBrazilianDate("03/04/2026"), "2026-04-03");
  assert.equal(parseBrazilianDate("29/02/2024"), "2024-02-29");
  for (const value of ["21/09/202", "2026-09-21", "31/04/2026", "29/02/2026", "00/00/0000", ""]) {
    assert.equal(parseBrazilianDate(value), null);
  }
});

test("date input validation accepts only real YYYY-MM-DD calendar values", () => {
  for (const value of ["2026-09-21", "2024-02-29", "0001-01-01"]) assert.equal(isValidIsoDate(value), true);
  for (const value of ["2026-02-29", "2026-2-03", "0000-01-01", "21/09/2026", "2026-09-21T00:00:00", ""]) {
    assert.equal(isValidIsoDate(value), false);
  }
});
