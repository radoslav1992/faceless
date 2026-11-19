// Lists the texts the code can show (for filling shared/locales/bg.ts, see docs/SITES.md): the text inside JSX, the
// words in attributes, and the sentences in data and messages. Texts with a changing part come out as templates
// ("{1} credits"). Prints JSON: [{ text, pattern?, file }]. Usage: node scripts/extract-texts.mjs [--missing]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const roots = ["src", "shared", "server"];
// Not here: the legal pages (Реч БГ has its own Bulgarian texts), the administrators' screens, and files whose strings are
// instructions to AI models or names of fonts and models.
const skip = /(^|\/)(i18n|locales)\/|\.test\.|\.d\.ts$|src\/public\/Legal\.tsx$|src\/app\/Admin[A-Za-z]*\.tsx$|server\/routes\/admin|shared\/(film|caption-fonts|credits|structured-data|track)\.ts$|server\/(providers|social)\//;
/** Properties whose text is an instruction to an AI model, never shown. */
const instructions = new Set(["prompt", "brief", "system", "negative", "look", "family", "recipe"]);
/** Whether a string in the server's code is a message for a person: an error or a validation message. */
function serverMessage(node, source) {
  for (let up = node.parent, depth = 0; up && depth < 8 && !ts.isBlock(up) && !ts.isSourceFile(up); up = up.parent, depth++) {
    if (ts.isCallExpression(up) || ts.isNewExpression(up)) {
      const called = up.expression.getText(source);
      if (/^console\.|\.prepare$|^sendMail$|^mail$|^fetch$|^rpcError$|^Error$/.test(called)) return false;
      if (/HTTPException$|^z\.|^fail[A-Z]|^tooMany$/.test(called)) return true;
    }
    if (ts.isPropertyAssignment(up)) { const name = up.name.getText(source); if (name === "message" || name === "error" || /^[A-Z][A-Z_]{3,}$/.test(name)) return true; }
  }
  return false;
}
/** Whether a string sits in a property that holds an instruction to a model. */
function instruction(node, source) {
  for (let up = node.parent, depth = 0; up && depth < 4; up = up.parent, depth++)
    if (ts.isPropertyAssignment(up) && instructions.has(up.name.getText(source))) return true;
  return false;
}
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx?$/.test(path) && !skip.test(path)) files.push(path); } };
roots.forEach(walk);

/** Attributes whose value is never words. */
const notWords = new Set(["className", "class", "to", "href", "src", "type", "name", "id", "key", "role", "htmlFor", "target", "rel", "viewBox", "d", "fill", "stroke", "method", "accept", "autoComplete", "inputMode", "pattern", "lang", "dir", "style", "value", "defaultValue", "path", "element", "as", "variant", "size", "kind", "mode", "strokeLinecap", "strokeLinejoin", "preload", "loading", "decoding", "crossOrigin", "translate", "tabIndex", "width", "height", "x", "y", "cx", "cy", "r", "rx", "ry", "points", "transform", "xmlns", "slot", "wrap", "align", "color", "icon", "format", "field", "template", "tone"]);
const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×", rarr: "→", larr: "←" };
const decode = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, code) => code[0] === "#" ? String.fromCodePoint(code[1] === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code] ?? all);
/** JSX text as the compiler hands it over: lines trimmed and joined with single spaces. */
function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let out = "";
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, " ");
    if (i > 0) s = s.replace(/^ +/, "");
    if (i < lines.length - 1) s = s.replace(/ +$/, "");
    if (s) out += (out && i > 0 ? " " : "") + s;
  });
  return decode(out).trim();
}
/** Words for people rather than a name, a path or a code. */
const words = (s) => /[A-Za-z]{2}/.test(s) && !/^[a-z0-9_./:#-]+$/.test(s) && !/^https?:|^[\w.+-]+@[\w.-]+$|^[A-Z0-9_]+$|^\//.test(s) && !/[Ѐ-ӿ]/.test(s);
/** A sentence or a phrase: several words, or a capital and a full stop. */
const phrase = (s) => words(s) && (/[A-Za-z] [A-Za-z]/.test(s) || /^[A-Z][a-z]+[.!?…:]?$/.test(s)) && !/^[a-z-]+( [a-z-]+)*$/.test(s) && !/[{}<>=;]|\$\(|^\s|^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/.test(s);
const found = new Map();
const add = (text, file, pattern) => { const key = text.trim(); if (key && !found.has(key)) found.set(key, { text: key, ...(pattern && { pattern }), file }); };

for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const name = relative(".", file);
  const server = name.startsWith("server/");
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isJsxText(node)) { const text = jsxText(node.getText(source)); if (words(text)) add(text, name); }
    else if (ts.isJsxAttribute(node)) {
      const attribute = node.name.getText(source);
      if (notWords.has(attribute) || attribute.startsWith("data-") || attribute.startsWith("on")) return;
      if (node.initializer && ts.isStringLiteral(node.initializer)) { if (words(node.initializer.text)) add(node.initializer.text, name); return; }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      // Not a property's name, a case of a switch or an argument that names something.
      if ((ts.isPropertyAssignment(parent) && parent.name === node) || ts.isCaseClause(parent) || ts.isElementAccessExpression(parent) || ts.isBinaryExpression(parent) && /===|!==|==|!=/.test(parent.operatorToken.getText(source))) return;
      const text = node.text;
      if (instruction(node, source)) return;
      if (server ? phrase(text) && serverMessage(node, source) : phrase(text)) add(text, name);
    } else if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      let template = node.head.text, n = 0;
      for (const span of node.templateSpans) template += `{${++n}}` + span.literal.text;
      const fixed = template.replace(/\{\d+\}/g, "");
      if (n <= 4 && phrase(fixed.trim() || "") && !/\n/.test(template) && !instruction(node, source) && (!server || serverMessage(node, source)) && !/^\/|api\/|https?:/.test(template)) add(template, name, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
let list = [...found.values()];
if (process.argv.includes("--missing")) {
  const { bg } = await import("../shared/locales/bg.ts").catch(() => ({ bg: null }));
  if (bg) list = list.filter((item) => !Object.hasOwn(bg.exact, item.text) && !item.pattern);
}
console.log(JSON.stringify(list, null, 1));
