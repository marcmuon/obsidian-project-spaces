// Creates a throwaway test vault for manual/acceptance testing, so the plugin
// can be exercised without touching a real vault's tabs or synced notes.
//
//   node scripts/sandbox-vault.mjs [dir]      (default: .sandbox-vault, gitignored)
//
// Idempotent: existing files are left alone. Contains synthetic content only.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".sandbox-vault");

function put(rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, content);
}

// Minimal one-page PDF with a correct xref table.
function tinyPdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, filled below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const para = (title) =>
  `# ${title}\n\n` +
  Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of ${title}. Scroll target text.`).join("\n\n") +
  "\n";

for (const n of ["A1", "A2", "A3", "A4"]) put(`Alpha/${n}.md`, para(`Alpha note ${n}`));
for (const n of ["B1", "B2", "B3"]) put(`Beta/${n}.md`, para(`Beta note ${n}`));
for (const n of ["C1", "C2"]) put(`Gamma/${n}.md`, para(`Gamma note ${n}`));
put("Shared/Board.canvas", JSON.stringify({
  nodes: [
    { id: "n1", type: "text", text: "Canvas node one", x: 0, y: 0, width: 240, height: 80 },
    { id: "n2", type: "file", file: "Alpha/A1.md", x: 320, y: 0, width: 400, height: 300 },
  ],
  edges: [{ id: "e1", fromNode: "n1", fromSide: "right", toNode: "n2", toSide: "left" }],
}, null, 2));
put("Shared/Paper.pdf", tinyPdf("Project Spaces sandbox PDF"));
put("Welcome.md", "# Sandbox vault\n\nSynthetic test vault for the Project Spaces plugin.\n");
put("ProjectSpaces.config.json", JSON.stringify({
  version: 1,
  projects: [
    { id: "project-a", name: "Project A" },
    { id: "project-b", name: "Project B" },
  ],
}, null, 2) + "\n");
mkdirSync(join(root, ".obsidian"), { recursive: true });
console.log(`Sandbox vault ready: ${root}`);
