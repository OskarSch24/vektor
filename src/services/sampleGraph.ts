import { GraphDocument } from '../types/graph';

/**
 * A small demonstration graph, built to show every shape the real pipeline
 * produces: a page and a video as sources, entities extracted from them, scenes
 * with timestamps, and a topic two sources share — which is the moment a
 * knowledge graph starts being worth more than two separate documents.
 */
export function sampleGraph(): GraphDocument {
  const now = new Date().toISOString();

  return {
    version: 1,
    metadata: {
      name: 'Beispielgraph',
      createdAt: now,
      updatedAt: now,
      sources: [
        {
          id: 'page:example.org/graphdatenbanken',
          kind: 'website',
          url: 'https://example.org/graphdatenbanken',
          title: 'Was Graphdatenbanken anders machen',
          ingestedAt: now,
          nodeIds: [
            'page:example.org/graphdatenbanken',
            'site:example-org',
            'person:mara-lindqvist',
            'organization:nordlicht-labs',
            'topic:graphdatenbank',
            'topic:wissensgraph',
            'place:goteborg',
          ],
        },
        {
          id: 'video:youtube.com/watch',
          kind: 'video',
          url: 'https://www.youtube.com/watch?v=beispiel',
          title: 'Wissensgraphen in 12 Minuten',
          ingestedAt: now,
          nodeIds: [
            'video:youtube.com/watch',
            'person:jonas-weber',
            'topic:entitaetserkennung',
            'video:youtube.com/watch#t120',
            'video:youtube.com/watch#t345',
          ],
        },
      ],
    },
    nodes: [
      {
        id: 'page:example.org/graphdatenbanken',
        labels: ['Page', 'Source'],
        properties: {
          title: 'Was Graphdatenbanken anders machen',
          url: 'https://example.org/graphdatenbanken',
          description:
            'Ein Überblick darüber, warum Beziehungen in einem Graphen erster Klasse sind und in einer Tabelle nicht.',
          kind: 'website',
          wordCount: 1840,
          summary:
            'Der Artikel vergleicht relationale Verbünde mit Kantenläufen und zeigt, ab welcher Tiefe der Graph gewinnt.',
        },
      },
      {
        id: 'site:example-org',
        labels: ['Site'],
        properties: { name: 'example.org', domain: 'example.org', url: 'https://example.org' },
      },
      {
        id: 'person:mara-lindqvist',
        labels: ['Person', 'Author'],
        properties: {
          name: 'Mara Lindqvist',
          description: 'Schreibt über Datenmodellierung.',
          source: 'json-ld',
        },
      },
      {
        id: 'organization:nordlicht-labs',
        labels: ['Organization'],
        properties: { name: 'Nordlicht Labs', description: 'Forschungsgruppe für Datenbanken.' },
      },
      {
        id: 'place:goteborg',
        labels: ['Place'],
        properties: { name: 'Göteborg' },
      },
      {
        id: 'topic:graphdatenbank',
        labels: ['Topic'],
        properties: { name: 'Graphdatenbank', source: 'keyword' },
      },
      {
        id: 'topic:wissensgraph',
        labels: ['Topic'],
        properties: { name: 'Wissensgraph', source: 'ki' },
      },
      {
        id: 'topic:entitaetserkennung',
        labels: ['Topic'],
        properties: { name: 'Entitätserkennung', source: 'ki' },
      },
      {
        id: 'video:youtube.com/watch',
        labels: ['Video', 'Source'],
        properties: {
          title: 'Wissensgraphen in 12 Minuten',
          url: 'https://www.youtube.com/watch?v=beispiel',
          kind: 'video',
          durationSeconds: 726,
          summary:
            'Erklärt Knoten, Kanten und Eigenschaften am Beispiel einer Nachrichtensammlung.',
        },
      },
      {
        id: 'person:jonas-weber',
        labels: ['Person', 'Author'],
        properties: { name: 'Jonas Weber', handle: '@jonasw', platform: 'youtube.com' },
      },
      {
        id: 'video:youtube.com/watch#t120',
        labels: ['Scene'],
        properties: {
          name: '2:00 — Tafel mit drei verbundenen Knoten',
          timestamp: 120,
          description: 'Eine Tafel, auf der drei Knoten mit beschrifteten Kanten verbunden werden.',
          onScreenText: 'Knoten · Kante · Eigenschaft',
        },
      },
      {
        id: 'video:youtube.com/watch#t345',
        labels: ['Scene'],
        properties: {
          name: '5:45 — Bildschirmaufnahme einer Abfrage',
          timestamp: 345,
          description: 'Bildschirmaufnahme, in der eine Abfrage über zwei Sprünge läuft.',
          onScreenText: 'MATCH (a)-[:NENNT]->(b)',
        },
      },
    ],
    edges: [
      edge('page:example.org/graphdatenbanken', 'VEROEFFENTLICHT_AUF', 'site:example-org'),
      edge('page:example.org/graphdatenbanken', 'VERFASST_VON', 'person:mara-lindqvist'),
      edge('page:example.org/graphdatenbanken', 'NENNT', 'organization:nordlicht-labs'),
      edge('page:example.org/graphdatenbanken', 'HANDELT_VON', 'topic:graphdatenbank'),
      edge('page:example.org/graphdatenbanken', 'HANDELT_VON', 'topic:wissensgraph'),
      edge('person:mara-lindqvist', 'ARBEITET_BEI', 'organization:nordlicht-labs'),
      edge('organization:nordlicht-labs', 'ANSAESSIG_IN', 'place:goteborg'),
      edge('video:youtube.com/watch', 'VERFASST_VON', 'person:jonas-weber'),
      edge('video:youtube.com/watch', 'HANDELT_VON', 'topic:wissensgraph'),
      edge('video:youtube.com/watch', 'HANDELT_VON', 'topic:entitaetserkennung'),
      edge('video:youtube.com/watch', 'ZEIGT_SZENE', 'video:youtube.com/watch#t120', {
        timestamp: 120,
      }),
      edge('video:youtube.com/watch', 'ZEIGT_SZENE', 'video:youtube.com/watch#t345', {
        timestamp: 345,
      }),
      edge('video:youtube.com/watch#t120', 'ZEIGT', 'topic:graphdatenbank'),
      edge('video:youtube.com/watch#t345', 'ZEIGT', 'topic:entitaetserkennung'),
    ],
  };
}

function edge(from: string, type: string, to: string, properties: Record<string, never | number> = {}) {
  return { id: `${from}|${type}|${to}`, type, from, to, properties };
}
