import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
// A hook/render test double exercises the real component callbacks without a DOM dependency.
// Native picker appearance still needs a device/browser check.
const hooksUrl = dataUrl(`
  export const runtime = { current: null };
  export function useState(initial) {
    const instance = runtime.current;
    const index = instance.cursor++;
    if (!(index in instance.slots)) instance.slots[index] = typeof initial === "function" ? initial() : initial;
    return [instance.slots[index], (next) => {
      const value = typeof next === "function" ? next(instance.slots[index]) : next;
      if (!Object.is(value, instance.slots[index])) { instance.slots[index] = value; instance.dirty = true; }
    }];
  }
  export function useRef(initial) {
    const instance = runtime.current;
    const index = instance.cursor++;
    return instance.slots[index] ??= { current: initial };
  }
  export function useId() { return useRef("test-date-id").current; }
  export function useEffect(effect, deps) {
    const instance = runtime.current;
    const index = instance.cursor++;
    const previous = instance.slots[index];
    if (!previous || deps.some((dep, position) => !Object.is(dep, previous[position]))) instance.effects.push(effect);
    instance.slots[index] = deps;
  }
`);
const jsxUrl = dataUrl("export function jsx(type, props) { return {type, props}; } export const jsxs = jsx;");
const iconsUrl = dataUrl("export function CalendarDays() { return null; }");
const compilerOptions = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX };
const helper = ts.transpileModule(await readFile(new URL("../src/services/dateFormat.ts", import.meta.url), "utf8"), { compilerOptions }).outputText;
const componentSource = await readFile(new URL("../src/components/BrazilianDateInput.tsx", import.meta.url), "utf8");
const component = ts.transpileModule(componentSource, { compilerOptions }).outputText
  .replace('from "react"', `from ${JSON.stringify(hooksUrl)}`)
  .replace('from "react/jsx-runtime"', `from ${JSON.stringify(jsxUrl)}`)
  .replace('from "lucide-react"', `from ${JSON.stringify(iconsUrl)}`)
  .replace('from "../services/dateFormat"', `from ${JSON.stringify(dataUrl(helper))}`)
  .replace('import "./BrazilianDateInput.css";', "");
const { runtime } = await import(hooksUrl);
const { BrazilianDateInput } = await import(dataUrl(component));

function createInput(initialValue) {
  const instance = { slots: [], effects: [], cursor: 0, dirty: false };
  let value = initialValue;
  const changes = [];
  function render() {
    let tree;
    for (let pass = 0; pass < 10; pass += 1) {
      runtime.current = instance;
      instance.cursor = 0;
      instance.dirty = false;
      tree = BrazilianDateInput({ value, required: true, ariaLabel: "Data do serviço", onChange: (next) => { value = next; changes.push(next); } });
      instance.effects.splice(0).forEach((effect) => effect());
      if (!instance.dirty) return tree;
    }
    throw new Error("Unexpected render loop");
  }
  function inputs() {
    const result = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "input") result.push(node.props);
      const children = node.props?.children;
      (Array.isArray(children) ? children : [children]).forEach(walk);
    }
    walk(render());
    return { text: result.find((input) => input.type === "text"), calendar: result.find((input) => input.type === "date") };
  }
  return { inputs, changes, get value() { return value; }, external(next) { value = next; } };
}

test("editing an existing ISO date preserves incomplete Brazilian text when the parent receives an empty value", () => {
  const input = createInput("2026-09-21");
  assert.equal(input.inputs().text.value, "21/09/2026");
  input.inputs().text.onChange({ target: { value: "21/09/202" } });
  assert.equal(input.value, "");
  assert.equal(input.inputs().text.value, "21/09/202");
  input.inputs().text.onBlur();
  assert.equal(input.inputs().text["aria-invalid"], true);
  input.inputs().text.onChange({ target: { value: "21/09/2027" } });
  assert.equal(input.value, "2027-09-21");
  assert.equal(input.inputs().text.value, "21/09/2027");
  assert.equal(input.inputs().text["aria-invalid"], false);
});

test("clearing, impossible dates and external updates preserve the intended controlled value", () => {
  const input = createInput("2026-09-21");
  input.inputs().text.onChange({ target: { value: "31/02/2026" } });
  input.inputs().text.onBlur();
  assert.equal(input.value, "");
  assert.equal(input.inputs().text.value, "31/02/2026");
  assert.equal(input.inputs().text["aria-invalid"], true);
  input.inputs().text.onChange({ target: { value: "" } });
  assert.equal(input.inputs().text.value, "");
  assert.equal(input.inputs().calendar.value, "");
  input.external("2027-12-31");
  assert.equal(input.inputs().text.value, "31/12/2027");
  assert.equal(input.inputs().calendar.value, "2027-12-31");
});

test("native calendar selections render Brazilian text and publish the original ISO date payload", () => {
  const input = createInput("");
  input.inputs().calendar.onChange({ target: { value: "2027-04-03" } });
  assert.equal(input.inputs().text.value, "03/04/2027");
  assert.deepEqual(input.changes, ["2027-04-03"]);
  assert.equal(input.inputs().calendar.lang, "pt-BR");
});

test("a separately mounted question starts from its own answer without another question's partial date", () => {
  const first = createInput("2026-09-21");
  first.inputs().text.onChange({ target: { value: "21/09/202" } });
  const second = createInput("2026-10-05");
  assert.equal(second.inputs().text.value, "05/10/2026");
  assert.equal(first.inputs().text.value, "21/09/202");
});
