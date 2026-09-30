/**
 * Renders a Jupyter notebook (`.ipynb`, nbformat 4) as Markdown for reading:
 * text cells as they are, code cells fenced in the kernel's language, and the
 * stored outputs below them — text, tables-as-text and images. Nothing is
 * executed; the outputs are whatever the notebook was saved with.
 */

interface NotebookCell {
  cell_type: 'markdown' | 'code' | 'raw';
  source: string | string[];
  execution_count?: number | null;
  outputs?: NotebookOutput[];
  attachments?: Record<string, Record<string, string | string[]>>;
}

interface NotebookOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Output images beyond this size are left out rather than inlined. */
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;
const MAX_TEXT_OUTPUT = 20_000;

export function isNotebookName(name: string): boolean {
  return /\.ipynb$/i.test(name);
}

export function notebookToMarkdown(json: string): string {
  let notebook: any;
  try {
    notebook = JSON.parse(json);
  } catch {
    throw new Error('Das Notebook ist kein gültiges JSON.');
  }
  if (!Array.isArray(notebook?.cells)) {
    throw new Error('Das Notebook hat keine Zellen (nur nbformat 4 wird unterstützt).');
  }

  const language = String(
    notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? 'python'
  ).toLowerCase();
  const kernel = notebook.metadata?.kernelspec?.display_name;
  const parts: string[] = [];
  if (kernel) parts.push(`<p class="md-notebook-meta">Jupyter-Notebook · ${escapeHtml(String(kernel))} · ${notebook.cells.length} Zellen · schreibgeschützt</p>`);

  for (const cell of notebook.cells as NotebookCell[]) {
    const source = joined(cell.source);
    if (cell.cell_type === 'markdown') {
      parts.push(inlineAttachments(source, cell.attachments));
    } else if (cell.cell_type === 'code') {
      const counter = cell.execution_count ? `In [${cell.execution_count}]` : 'In [ ]';
      parts.push(`<p class="md-notebook-prompt">${counter}</p>\n\n${fence(source, language)}`);
      for (const output of cell.outputs ?? []) {
        const rendered = renderOutput(output);
        if (rendered) parts.push(rendered);
      }
    } else if (source.trim()) {
      parts.push(fence(source, ''));
    }
  }
  return parts.join('\n\n');
}

function renderOutput(output: NotebookOutput): string | null {
  if (output.output_type === 'stream') return fence(truncate(joined(output.text)), 'text');
  if (output.output_type === 'error') {
    const trace = (output.traceback ?? []).join('\n').replace(/\u001b\[[\d;]*m/g, '');
    return fence(truncate(trace || `${output.ename}: ${output.evalue}`), 'text');
  }
  const data = output.data ?? {};
  for (const type of ['image/png', 'image/jpeg', 'image/gif']) {
    const payload = data[type];
    if (!payload) continue;
    const base64 = joined(payload).replace(/\s/g, '');
    if (base64.length > MAX_IMAGE_BASE64) return '*(Bildausgabe zu groß für die Vorschau)*';
    return `![Ausgabe](data:${type};base64,${base64})`;
  }
  // SVG and HTML outputs are shown as their text: executing notebook HTML in
  // the app's own web view is not something a file viewer should do.
  if (data['text/markdown']) return joined(data['text/markdown']);
  if (data['text/plain']) return fence(truncate(joined(data['text/plain'])), 'text');
  if (data['text/html']) return '*(HTML-Ausgabe — im Notebook selbst ansehen)*';
  return null;
}

/** `![](attachment:bild.png)` → inline data URI. */
function inlineAttachments(source: string, attachments: NotebookCell['attachments']): string {
  if (!attachments) return source;
  return source.replace(/attachment:([^)\s]+)/g, (match, name: string) => {
    const bundle = attachments[decodeURIComponent(name)];
    const type = bundle && Object.keys(bundle).find((key) => key.startsWith('image/'));
    return type ? `data:${type};base64,${joined(bundle[type]).replace(/\s/g, '')}` : match;
  });
}

function fence(code: string, language: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}\n${code.replace(/\n$/, '')}\n${ticks}`;
}

function joined(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join('') : value ?? '';
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_OUTPUT
    ? `${text.slice(0, MAX_TEXT_OUTPUT)}\n… (${(text.length - MAX_TEXT_OUTPUT).toLocaleString('de-DE')} weitere Zeichen)`
    : text;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
