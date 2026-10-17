// An extraction plan is what the LLM writes ONCE: CSS selectors + how to read
// and coerce each field. Running it needs no LLM — it is deterministic, free and
// fast — so the model is paid for once per site layout, not once per page.
export type FieldType = "string" | "number" | "integer" | "boolean" | "string[]" | "object" | "object[]";

export type FieldPlan = {
  name: string;
  // CSS selector relative to the parent element. For "object[]" / "string[]" it
  // matches every item; otherwise the first match is used. null = the parent.
  selector: string | null;
  // "text" (default), "html", or an attribute name such as "href", "src",
  // "content", "datetime", "data-price".
  attribute?: string | null;
  type: FieldType;
  // Optional regex; the first capture group (or whole match) is kept.
  pattern?: string | null;
  fields?: FieldPlan[];
};

export type ExtractionPlan = {
  version: 1;
  // "object": one record from the page; "list": the root selector matches each
  // record (the schema is an array).
  kind: "object" | "list";
  root: string | null;
  fields: FieldPlan[];
};

// JSON Schema for the plan itself — what the LLM must return. Kept two levels
// deep and without recursion/dynamic keys, which every structured-output
// provider accepts.
const LEAF_FIELD = {
  type: "object",
  properties: {
    name: { type: "string" },
    selector: { type: ["string", "null"] },
    attribute: { type: ["string", "null"] },
    type: { type: "string", enum: ["string", "number", "integer", "boolean", "string[]"] },
    pattern: { type: ["string", "null"] },
  },
  required: ["name", "selector", "attribute", "type", "pattern"],
  additionalProperties: false,
};

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["object", "list"] },
    root: { type: ["string", "null"], description: "For kind=list: selector matching each record. For kind=object: container selector or null for the document." },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...LEAF_FIELD.properties,
          type: { type: "string", enum: ["string", "number", "integer", "boolean", "string[]", "object", "object[]"] },
          fields: { type: ["array", "null"], items: LEAF_FIELD, description: "Sub-fields for type object / object[] (selectors relative to each match)." },
        },
        required: [...LEAF_FIELD.required, "fields"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "root", "fields"],
  additionalProperties: false,
};

// Self-contained (no closures, no imports): it is also shipped as source into
// the page's isolated world. Works on browser DOM elements and on
// node-html-parser elements (querySelectorAll / getAttribute / textContent).
export function runPlan(root: any, plan: ExtractionPlan): unknown {
  function clean(text: unknown): string {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }
  function to_number(raw: string): number | null {
    const match = raw.replace(/\s/g, "").match(/-?[\d.,]+/);
    if (!match) {
      return null;
    }
    let num = match[0];
    const last_comma = num.lastIndexOf(",");
    const last_dot = num.lastIndexOf(".");
    if (last_comma > -1 && last_dot > -1) {
      // The later separator is the decimal one: 1.234,56 / 1,234.56
      num = last_comma > last_dot ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
    } else if (last_comma > -1) {
      // "19,90" → decimal; "1,234" → thousands.
      num = /,\d{1,2}$/.test(num) && num.split(",").length === 2 ? num.replace(",", ".") : num.replace(/,/g, "");
    } else if ((num.match(/\./g) || []).length > 1) {
      num = num.replace(/\./g, "");
    }
    const value = parseFloat(num);
    return isFinite(value) ? value : null;
  }
  function all(el: any, selector: string | null): any[] {
    if (!selector) {
      return el ? [el] : [];
    }
    try {
      return Array.from(el.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }
  function read(el: any, attribute: string | null | undefined): string {
    if (!el) {
      return "";
    }
    if (!attribute || attribute === "text") {
      return clean(el.innerText !== undefined && el.innerText !== "" ? el.innerText : el.textContent);
    }
    if (attribute === "html") {
      return String(el.innerHTML || "");
    }
    const value = el.getAttribute(attribute);
    if (value == null) {
      return "";
    }
    if ((attribute === "href" || attribute === "src") && typeof el[attribute] === "string" && el[attribute]) {
      return el[attribute];
    }
    return clean(value);
  }
  function apply_pattern(value: string, pattern: string | null | undefined): string {
    if (!pattern) {
      return value;
    }
    try {
      const match = value.match(new RegExp(pattern));
      return match ? clean(match[1] !== undefined ? match[1] : match[0]) : "";
    } catch (_error) {
      return value;
    }
  }
  function coerce(raw: string, type: string): unknown {
    if (type === "number" || type === "integer") {
      const n = to_number(raw);
      return n === null ? null : type === "integer" ? Math.round(n) : n;
    }
    if (type === "boolean") {
      const v = raw.toLowerCase();
      if (!v) {
        return null;
      }
      return !/^(false|no|0|off|n[aã]o|sold out|out of stock|esgotado|indispon[ií]vel|unavailable)$/.test(v);
    }
    return raw === "" ? null : raw;
  }
  function field(parent: any, f: FieldPlan): unknown {
    if (f.type === "object[]") {
      return all(parent, f.selector).map((item) => record(item, f.fields || []));
    }
    if (f.type === "object") {
      const el = all(parent, f.selector)[0];
      return el ? record(el, f.fields || []) : null;
    }
    if (f.type === "string[]") {
      return all(parent, f.selector)
        .map((el) => apply_pattern(read(el, f.attribute), f.pattern))
        .filter((value) => value !== "");
    }
    const el = all(parent, f.selector)[0];
    return coerce(apply_pattern(read(el, f.attribute), f.pattern), f.type);
  }
  function record(el: any, fields: FieldPlan[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      out[f.name] = field(el, f);
    }
    return out;
  }

  const doc_root = root && root.documentElement ? root.documentElement : root;
  if (plan.kind === "list") {
    return all(doc_root, plan.root).map((item) => record(item, plan.fields));
  }
  const container = plan.root ? all(doc_root, plan.root)[0] : doc_root;
  return container ? record(container, plan.fields) : null;
}

export function normalizePlan(raw: any): ExtractionPlan {
  const fix = (f: any): FieldPlan => ({
    name: String(f?.name ?? ""),
    selector: f?.selector ?? null,
    attribute: f?.attribute ?? null,
    type: (f?.type ?? "string") as FieldType,
    pattern: f?.pattern ?? null,
    ...(Array.isArray(f?.fields) && f.fields.length > 0 ? { fields: f.fields.map(fix) } : {}),
  });
  return {
    version: 1,
    kind: raw?.kind === "list" ? "list" : "object",
    root: raw?.root ?? null,
    fields: Array.isArray(raw?.fields) ? raw.fields.map(fix) : [],
  };
}
