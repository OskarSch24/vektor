import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Columns2, Eye, FolderOpen, PenLine, RotateCw, Save } from 'lucide-react';
import { files, isNativeHost } from '../services/nativeHost';
import {
  MARKDOWN_NAME,
  type ActiveSource,
  type OpenDisposition,
} from '../workbench/model';
import {
  countWords,
  folderOf,
  isRelativeReference,
  localImageSource,
  renderMarkdown,
  resolvePath,
  slugify,
  splitFrontmatter,
} from './render';
import { markdownBuffers as buffers, type MarkdownBuffer } from './buffers';
import { isNotebookName, notebookToMarkdown } from './notebook';
import './markdown.css';

type ViewMode = 'preview' | 'split' | 'source';

const stagedImages = new Map<string, Promise<string>>();

const MODE_STORAGE_KEY = 'vektor.markdown.mode';
/** Links to these open inside Vektor; any other local file is shown in Finder. */
const OPENABLE_FILE = /\.(?:md|markdown|mdown|mkd|mkdn|graph|json|jsonl|ndjson|csv|tsv|xlsx|xlsm|sqlite[23]?|db3?|ya?ml|xml|toml|geojson|parquet|arrow|feather|ipc|duckdb|amqrun)$/i;

function readStoredMode(): ViewMode {
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'preview' || stored === 'split' || stored === 'source') return stored;
  } catch {
    // Storage may be unavailable; the reading view is the sensible default.
  }
  return 'preview';
}

interface MarkdownStudioProps {
  source: ActiveSource;
  sessionKey: string;
  onDirtyChange: (dirty: boolean) => void;
  onOpenPath: (path: string, disposition: OpenDisposition) => void;
  onNotice: (message: string) => void;
}

export const MarkdownStudio: FC<MarkdownStudioProps> = ({
  source,
  sessionKey,
  onDirtyChange,
  onOpenPath,
  onNotice,
}) => {
  // The store is the source of truth; this counter only asks for a re-render.
  const [, setRevision] = useState(0);
  const buffer = buffers.get(sessionKey) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [storedMode, setMode] = useState<ViewMode>(readStoredMode);
  /** Notebooks are rendered from JSON; editing that as Markdown would corrupt them. */
  const readOnly = isNotebookName(source.name);
  const mode: ViewMode = readOnly ? 'preview' : storedMode;
  const [isSaving, setIsSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const scrollLock = useRef<'editor' | 'preview' | null>(null);
  const path = source.path;
  const dirty = buffer !== null && buffer.text !== buffer.saved;

  const commit = useCallback((next: MarkdownBuffer) => {
    buffers.set(sessionKey, next);
    setRevision((revision) => revision + 1);
  }, [sessionKey]);

  /** Re-reads the file unless the user has unsaved edits in it. */
  const load = useCallback(async (force = false) => {
    if (!path) {
      setError('Diese Notiz hat keinen Speicherort.');
      return;
    }
    if (!isNativeHost()) {
      setError('Markdown-Dateien öffnen sich in der Vektor-App, nicht in der Browser-Vorschau.');
      return;
    }
    try {
      const file = await files.read(path);
      const contents = readOnly ? notebookToMarkdown(file.contents) : file.contents;
      const current = buffers.get(sessionKey);
      if (current && current.text !== current.saved && !force) return;
      if (current && current.saved === contents && current.text === contents) return;
      setError(null);
      commit({ path, saved: contents, text: contents });
    } catch (err) {
      setError(`„${source.name}“ konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [commit, path, readOnly, sessionKey, source.name]);

  useEffect(() => {
    setError(null);
    void load();
  }, [load]);

  // Another editor may have changed the note while Vektor was in the background.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const changeMode = useCallback((next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Not remembering the choice is harmless.
    }
  }, []);

  const save = useCallback(async () => {
    const current = buffers.get(sessionKey);
    if (readOnly || !current || current.text === current.saved || isSaving) return;
    setIsSaving(true);
    try {
      await files.write(current.path, current.text);
      const latest = buffers.get(sessionKey) ?? current;
      commit({ ...latest, saved: current.text });
    } catch (err) {
      onNotice(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [commit, isSaving, onNotice, readOnly, sessionKey]);

  useEffect(() => {
    const onSaveRequest = () => void save();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('database-studio:save-active', onSaveRequest);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('database-studio:save-active', onSaveRequest);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [save]);

  const text = buffer?.text ?? '';
  const deferredText = useDeferredValue(text);
  const rendered = useMemo(() => {
    const frontmatter = splitFrontmatter(deferredText);
    return {
      frontmatter: frontmatter?.raw ?? null,
      html: renderMarkdown(frontmatter ? frontmatter.body : deferredText),
    };
  }, [deferredText]);

  // Heading anchors and images that live next to the note.
  useLayoutEffect(() => {
    const root = previewRef.current;
    if (!root || !path) return;
    const seen = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      const base = slugify(heading.textContent ?? '') || 'abschnitt';
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      heading.id = count ? `${base}-${count}` : base;
    });
    if (!isNativeHost()) return;
    const folder = folderOf(path);
    root.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
      const reference = localImageSource(image);
      if (!reference) return;
      const imagePath = resolvePath(folder, reference);
      let staged = stagedImages.get(imagePath);
      if (!staged) {
        staged = files.stage(imagePath).then((file) => file.url);
        stagedImages.set(imagePath, staged);
        staged.catch(() => stagedImages.delete(imagePath));
      }
      void staged.then((url) => { image.src = url; }).catch(() => {
        image.alt = image.alt ? `${image.alt} (Bild nicht gefunden)` : 'Bild nicht gefunden';
        image.classList.add('is-missing');
      });
    });
  }, [rendered, mode, path]);

  const handlePreviewClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || href === null || href === undefined) return;
    event.preventDefault();

    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      previewRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    if (!isRelativeReference(href)) {
      if (!/^(?:https?|mailto):/i.test(href)) return;
      // The native host hands http(s) navigations to the default browser.
      if (isNativeHost()) window.location.assign(href);
      else window.open(href, '_blank', 'noopener');
      return;
    }
    if (!path) return;
    const target = resolvePath(folderOf(path), href);
    const disposition: OpenDisposition = event.metaKey || event.ctrlKey ? 'new-tab' : 'current';
    if (OPENABLE_FILE.test(target)) onOpenPath(target, disposition);
    else void files.reveal(target).catch(() => onNotice(`„${href}“ wurde nicht gefunden.`));
  }, [onNotice, onOpenPath, path]);

  const handleEditorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const editor = event.currentTarget;
    const { selectionStart, selectionEnd, value } = editor;
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const indent = /^ {1,2}|^\t/.exec(value.slice(lineStart))?.[0].length ?? 0;
      if (!indent) return;
      editor.setRangeText('', lineStart, lineStart + indent, 'preserve');
    } else {
      editor.setRangeText('  ', selectionStart, selectionEnd, 'end');
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, []);

  // Split view keeps both panes at the same relative position.
  const syncScroll = useCallback((from: 'editor' | 'preview') => {
    if (mode !== 'split') return;
    if (scrollLock.current && scrollLock.current !== from) return;
    const origin = from === 'editor' ? editorRef.current : previewRef.current;
    const target = from === 'editor' ? previewRef.current : editorRef.current;
    if (!origin || !target) return;
    scrollLock.current = from;
    const range = origin.scrollHeight - origin.clientHeight;
    const ratio = range > 0 ? origin.scrollTop / range : 0;
    target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
    window.requestAnimationFrame(() => { scrollLock.current = null; });
  }, [mode]);

  const stats = useMemo(() => {
    const words = countWords(deferredText);
    return {
      words,
      lines: deferredText ? deferredText.split('\n').length : 0,
      minutes: Math.max(1, Math.round(words / 220)),
    };
  }, [deferredText]);

  const isMarkdown = MARKDOWN_NAME.test(source.name.toLocaleLowerCase());

  return (
    <div className="markdown-studio flex h-full min-h-0 flex-col bg-[#181818]">
      <header className="markdown-toolbar">
        {readOnly ? (
          <span className="markdown-readonly">Notebook · nur lesen</span>
        ) : (
          <div className="markdown-mode" role="tablist" aria-label="Ansicht">
            <ModeButton mode="preview" current={mode} onSelect={changeMode} icon={Eye} label="Lesen" />
            <ModeButton mode="split" current={mode} onSelect={changeMode} icon={Columns2} label="Geteilt" />
            <ModeButton mode="source" current={mode} onSelect={changeMode} icon={PenLine} label="Bearbeiten" />
          </div>
        )}
        <span className="markdown-stats">
          {stats.words.toLocaleString('de-DE')} Wörter · {stats.lines.toLocaleString('de-DE')} Zeilen · ~{stats.minutes} Min.
        </span>
        <span className="flex-1" />
        {dirty && <span className="markdown-dirty">Ungesichert</span>}
        {path && isNativeHost() && (
          <button className="markdown-tool" onClick={() => void files.reveal(path)} title="Im Finder zeigen">
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.7} />
          </button>
        )}
        <button
          className="markdown-tool"
          onClick={() => void load()}
          disabled={dirty}
          title={dirty ? 'Erst speichern oder Änderungen verwerfen' : 'Von der Festplatte neu laden'}
        >
          <RotateCw className="h-3.5 w-3.5" strokeWidth={1.7} />
        </button>
        {!readOnly && (
          <button
            className="markdown-tool markdown-save"
            onClick={() => void save()}
            disabled={!dirty || isSaving}
            title="Speichern (⌘S)"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.7} />
            <span>Sichern</span>
          </button>
        )}
      </header>

      {error ? (
        <div className="grid flex-1 place-items-center p-8 text-center text-[12px] text-apple-text-tertiary">
          <p className="max-w-md">{error}</p>
        </div>
      ) : buffer === null ? (
        <div className="grid flex-1 place-items-center text-[11px] text-apple-text-tertiary">
          {isMarkdown ? 'Notiz wird gelesen…' : 'Datei wird gelesen…'}
        </div>
      ) : (
        <div className={`markdown-panes markdown-panes-${mode}`}>
          {mode !== 'preview' && (
            <textarea
              ref={editorRef}
              className="markdown-editor"
              value={text}
              spellCheck
              lang="de"
              aria-label={`Quelltext von ${source.name}`}
              onChange={(event) => commit({ ...buffer, text: event.target.value })}
              onKeyDown={handleEditorKeyDown}
              onScroll={() => syncScroll('editor')}
            />
          )}
          {mode !== 'source' && (
            <div
              ref={previewRef}
              className="markdown-preview"
              onClick={handlePreviewClick}
              onScroll={() => syncScroll('preview')}
            >
              <article className="md-prose">
                {rendered.frontmatter !== null && (
                  <details className="md-frontmatter">
                    <summary>Eigenschaften</summary>
                    <pre>{rendered.frontmatter}</pre>
                  </details>
                )}
                {text.trim() === '' ? (
                  <p className="md-empty">Diese Notiz ist leer. Unter „Bearbeiten“ schreiben.</p>
                ) : (
                  <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
                )}
              </article>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface ModeButtonProps {
  mode: ViewMode;
  current: ViewMode;
  onSelect: (mode: ViewMode) => void;
  icon: typeof Eye;
  label: string;
}

const ModeButton: FC<ModeButtonProps> = ({ mode, current, onSelect, icon: Icon, label }) => (
  <button
    role="tab"
    aria-selected={mode === current}
    className={mode === current ? 'is-active' : undefined}
    onClick={() => onSelect(mode)}
  >
    <Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
    <span>{label}</span>
  </button>
);
