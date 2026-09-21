#!/usr/bin/env node
/**
 * Beispielablage nach dem Vertrag des Sammlers — nur, damit `map.mjs` gegen
 * etwas gebaut und geprüft werden kann, solange der Sammler noch nicht gelaufen
 * ist. Sobald `staged/` echte Daten enthält, wird diese Datei nicht mehr
 * gebraucht; sie schreibt deshalb standardmässig nach `staged-fixtures/`.
 *
 *   node tools/codewiki/map-fixtures.mjs [ZIELVERZEICHNIS]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Ein Deep-Link, wie ihn codewiki erzeugt: URL-kodiert, mit Zeilenanker. */
const deep = (owner, repo, file, line) =>
  `%2F${owner}%2F${repo}%2F${file.split('/').join('%2F')}${line ? `#L${line}` : ''}`;

const repos = [
  {
    owner: 'nordlicht',
    name: 'ferrylog',
    sections: [
      {
        title: 'Overview',
        level: 1,
        description: 'Was ferrylog tut und wie die Teile zusammenhängen.',
        sourceFiles: ['README.md', 'src/index.ts'],
        markdown: [
          'ferrylog schreibt strukturierte Ereignisse in einen Ringpuffer.',
          '',
          `Der Einstiegspunkt liegt in [src/index.ts](${deep('nordlicht', 'ferrylog', 'src/index.ts', 12)}).`,
          `Die Serialisierung übernimmt [src/encode.ts](${deep('nordlicht', 'ferrylog', 'src/encode.ts', 44)}).`,
          '',
          'Für den Transport wird [nordlicht/pierwire](https://github.com/nordlicht/pierwire) benutzt,',
          'die Zeitstempel kommen aus [hafenamt/tidalclock](https://github.com/hafenamt/tidalclock).',
          '',
          'Beispiel:',
          '',
          '```bash',
          '# Example HTTP requests using curl',
          'curl https://github.com/nicht/verlinken -d @payload.json',
          '```',
          '',
          'Mehr zum Format steht in der [Graphviz-Doku](https://graphviz.org/doc/info/lang.html).',
        ].join('\n'),
        diagramDot: [
          'digraph ferrylog {',
          '  rankdir=LR;',
          '  node [shape=box];',
          '  // der Kern',
          '  writer [label="Writer"];',
          '  ring   [label="Ring Buffer"];',
          '  subgraph cluster_io {',
          '    label="I/O";',
          '    encoder [label="Encoder"];',
          '    sink    [label="Sink"];',
          '  }',
          '  writer -> ring [label="append"];',
          '  ring -> encoder -> sink;',
          '  writer -> { encoder sink } [label="flush"];',
          '}',
        ].join('\n'),
        diagramSvg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      },
      {
        title: 'Encoding',
        level: 2,
        description: 'Wie ein Ereignis in Bytes übergeht.',
        sourceFiles: ['src/encode.ts', 'src/varint.ts'],
        markdown: [
          `Varints werden in [src/varint.ts](${deep('nordlicht', 'ferrylog', 'src/varint.ts', 8)}) gelesen.`,
          'Die Tabelle stammt aus [nordlicht/pierwire](https://github.com/nordlicht/pierwire/blob/main/src/table.ts).',
        ].join('\n'),
        diagramDot: '',
        diagramSvg: '',
      },
      {
        title: 'Why This Error Occurred',
        level: 3,
        description: '',
        sourceFiles: [],
        markdown: 'Ein Vorlagenbaustein, der als echte Überschrift im Wiki gelandet ist.',
        diagramDot: '',
        diagramSvg: '',
      },
      {
        title: 'Why This Error Occurred',
        level: 3,
        description: 'Zweites Vorkommen — derselbe Titel, anderer Abschnitt.',
        sourceFiles: [],
        markdown: 'Und noch einmal derselbe Baustein.',
        diagramDot: '',
        diagramSvg: '',
      },
      {
        title: 'Storage',
        level: 2,
        description: 'Ablage auf der Platte.',
        sourceFiles: ['src/store/segment.ts', 'src/store/index.ts', 'README.md'],
        markdown: [
          `Segmente liegen unter [src/store/segment.ts](${deep('nordlicht', 'ferrylog', 'src/store/segment.ts', 101)}).`,
          'Siehe auch ./src/store/index.ts im selben Verzeichnis.',
        ].join('\n'),
        diagramDot: 'graph storage { segment -- index; index -- manifest }',
        diagramSvg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      },
    ],
  },
  {
    owner: 'nordlicht',
    name: 'pierwire',
    ownerType: 'Organization',
    sections: [
      {
        title: 'Protocol',
        level: 1,
        description: 'Das Drahtformat.',
        sourceFiles: ['src/table.ts', 'src/frame.ts'],
        markdown: [
          `Rahmen werden in [src/frame.ts](${deep('nordlicht', 'pierwire', 'src/frame.ts', 3)}) beschrieben.`,
          'Der Konsument ist [nordlicht/ferrylog](https://github.com/nordlicht/ferrylog).',
        ].join('\n'),
        diagramDot: [
          'digraph protocol {',
          '  header -> payload;',
          '  payload -> checksum [label="covers"];',
          '  "frame:0" [label=<<b>Frame</b><br/>v2>];',
          '  "frame:0" -> header;',
          '}',
        ].join('\n'),
        diagramSvg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      },
      {
        title: '# Example HTTP requests using curl',
        level: 2,
        description: '',
        sourceFiles: [],
        markdown: '```sh\ncurl -X POST https://example.invalid/frames\n```',
        diagramDot: '',
        diagramSvg: '',
      },
    ],
  },
  {
    owner: 'hafenamt',
    name: 'tidalclock',
    ownerType: 'User',
    sections: [
      {
        title: 'Clock',
        level: 1,
        description: 'Monotone Zeitquelle.',
        sourceFiles: ['clock.go', 'internal/skew.go'],
        markdown: [
          `Siehe [clock.go](${deep('hafenamt', 'tidalclock', 'clock.go', 20)}).`,
          'Wird von [nordlicht/ferrylog](https://github.com/nordlicht/ferrylog) benutzt.',
          'Hintergrund: <https://en.wikipedia.org/wiki/Monotonic_function>',
        ].join('\n'),
        diagramDot: 'digraph { clock -> skew; skew -> monotonic }',
        diagramSvg: '',
      },
    ],
  },
];

async function main() {
  const root = path.resolve(process.argv[2] ?? path.join(HERE, 'staged-fixtures'));

  for (const repo of repos) {
    const dir = path.join(root, `${repo.owner}__${repo.name}`);
    await mkdir(path.join(dir, 'sections'), { recursive: true });

    const sections = repo.sections.map((section, index) => ({ index, ...section }));
    const wiki = sections
      .map((section) => `${'#'.repeat(section.level)} ${section.title}\n\n${section.markdown}\n`)
      .join('\n');

    const meta = {
      owner: repo.owner,
      name: repo.name,
      repoSlug: `${repo.owner}/${repo.name}`,
      githubUrl: `https://github.com/${repo.owner}/${repo.name}`,
      codewikiUrl: `https://codewiki.example/${repo.owner}/${repo.name}`,
      commitSha: `${repo.name}0000000000000000000000000000000000`.slice(0, 40),
      capturedAt: '2026-09-04T12:00:00.000Z',
      checksum: `sha256:${repo.name}`,
      sectionCount: sections.length,
      markdownChars: wiki.length,
      hasWiki: true,
    };

    await writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    await writeFile(path.join(dir, 'wiki.md'), wiki);
    await writeFile(path.join(dir, 'sections.json'), `${JSON.stringify(sections, null, 2)}\n`);
    await writeFile(
      path.join(dir, 'raw.json'),
      `${JSON.stringify(
        { owner: { login: repo.owner, type: repo.ownerType ?? undefined }, sections: sections.length },
        null,
        2
      )}\n`
    );
    for (const section of sections) {
      if (section.diagramSvg) {
        await writeFile(path.join(dir, 'sections', `${section.index}.svg`), section.diagramSvg);
      }
    }
    process.stdout.write(`${dir}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exitCode = 1;
});
