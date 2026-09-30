import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, folderOf, isRelativeReference, resolvePath, slugify, splitFrontmatter } from '../src/markdown/render';
import { fileTypeForName, workspaceFor } from '../src/workbench/model';

test('markdown files open in the markdown workspace', () => {
  for (const name of ['README.md', 'Notiz.MARKDOWN', 'a.mdown', 'b.mkd']) {
    const fileType = fileTypeForName(name);
    assert.equal(fileType, 'markdown');
    assert.equal(workspaceFor({ name, fileType }), 'markdown');
  }
  assert.equal(fileTypeForName('daten.csv'), 'csv');
});

test('relative links resolve against the note folder', () => {
  const folder = folderOf('/Users/o/notes/Test-Notiz.md');
  assert.equal(folder, '/Users/o/notes');
  assert.equal(resolvePath(folder, './Zweite%20Notiz.md'), '/Users/o/notes/Zweite Notiz.md');
  assert.equal(resolvePath(folder, '../bilder/a.png?x=1'), '/Users/o/bilder/a.png');
  assert.equal(resolvePath(folder, 'sub/c.md#abschnitt'), '/Users/o/notes/sub/c.md');
  assert.equal(resolvePath(folder, '/abs/d.md'), '/abs/d.md');
});

test('only scheme-less references count as local', () => {
  assert.ok(isRelativeReference('bild.png'));
  assert.ok(!isRelativeReference('https://example.com'));
  assert.ok(!isRelativeReference('mailto:a@b.de'));
  assert.ok(!isRelativeReference('#tabelle'));
  assert.ok(!isRelativeReference('data:image/png;base64,AA'));
});

test('frontmatter, slugs and word counts', () => {
  assert.deepEqual(splitFrontmatter('---\ntitel: X\n---\n# Kopf\n'), { raw: 'titel: X', body: '# Kopf\n' });
  assert.equal(splitFrontmatter('# Kein Frontmatter'), null);
  assert.equal(slugify('Über uns: Größe & Maß'), 'über-uns-größe--maß');
  assert.equal(countWords('Ein Satz, mit fünf Wörtern!'), 5);
});
