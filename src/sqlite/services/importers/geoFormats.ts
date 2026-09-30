import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * KML (Google Earth, My Maps) and GPX (GPS tracks) as a GeoJSON
 * FeatureCollection, so map, document tree and table all read them the same
 * way they read `.geojson`.
 */

type Position = [number, number] | [number, number, number];

interface Feature {
  type: 'Feature';
  geometry: Record<string, unknown> | null;
  properties: Record<string, unknown>;
}

export function geoFormatToGeoJson(text: string, extension: 'kml' | 'gpx'): { type: 'FeatureCollection'; features: Feature[] } {
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`XML: ${valid.err.msg} (Zeile ${valid.err.line})`);
  const root = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    removeNSPrefix: true,
    textNodeName: '#text',
    // Keep repeatable elements as arrays so a single point is not special.
    isArray: (name) => ['Placemark', 'Folder', 'Document', 'Point', 'LineString', 'Polygon', 'LinearRing',
      'innerBoundaryIs', 'Data', 'SimpleData', 'wpt', 'trk', 'trkseg', 'trkpt', 'rte', 'rtept', 'coord', 'when'].includes(name),
  }).parse(text);
  const features = extension === 'kml' ? readKml(root.kml) : readGpx(root.gpx);
  if (features.length === 0) throw new Error('keine Orte, Routen oder Tracks gefunden');
  return { type: 'FeatureCollection', features };
}

// MARK: - KML

function readKml(kml: any): Feature[] {
  if (!kml) throw new Error('kein <kml>-Element');
  const features: Feature[] = [];
  const visit = (container: any, folder: string | null) => {
    for (const placemark of list(container?.Placemark)) {
      const geometry = kmlGeometry(placemark);
      const properties: Record<string, unknown> = {};
      const name = text(placemark.name);
      if (name !== undefined) properties.name = name;
      const description = text(placemark.description);
      if (description !== undefined) properties.beschreibung = description;
      if (folder) properties.ordner = folder;
      for (const data of list(placemark.ExtendedData?.Data)) {
        const key = attr(data, 'name');
        if (key) properties[key] = text(data.value) ?? null;
      }
      for (const schemaData of list(placemark.ExtendedData?.SchemaData)) {
        for (const data of list(schemaData.SimpleData)) {
          const key = attr(data, 'name');
          if (key) properties[key] = text(data) ?? null;
        }
      }
      const when = text(placemark.TimeStamp?.when?.[0] ?? placemark.TimeStamp?.when);
      if (when) properties.zeit = when;
      features.push({ type: 'Feature', geometry, properties });
    }
    for (const nested of [...list(container?.Document), ...list(container?.Folder)]) {
      const name = text(nested.name);
      visit(nested, name ?? folder);
    }
  };
  visit(kml, null);
  return features;
}

function kmlGeometry(element: any): Record<string, unknown> | null {
  const parts: Record<string, unknown>[] = [];
  for (const point of list(element.Point)) {
    const [position] = kmlCoordinates(point.coordinates);
    if (position) parts.push({ type: 'Point', coordinates: position });
  }
  for (const line of list(element.LineString)) {
    const positions = kmlCoordinates(line.coordinates);
    if (positions.length > 1) parts.push({ type: 'LineString', coordinates: positions });
  }
  for (const polygon of list(element.Polygon)) {
    const outer = kmlCoordinates(list(polygon.outerBoundaryIs)[0]?.LinearRing?.[0]?.coordinates);
    const inner = list(polygon.innerBoundaryIs).map((ring: any) => kmlCoordinates(ring.LinearRing?.[0]?.coordinates));
    if (outer.length > 3) parts.push({ type: 'Polygon', coordinates: [outer, ...inner.filter((ring) => ring.length > 3)] });
  }
  // gx:Track (Google's timed tracks) after namespace removal.
  for (const track of list(element.Track)) {
    const positions = list(track.coord).map((entry: any) => parsePosition(String(text(entry) ?? '').trim().split(/\s+/)))
      .filter(Boolean) as Position[];
    if (positions.length > 1) parts.push({ type: 'LineString', coordinates: positions });
  }
  for (const multi of list(element.MultiGeometry)) {
    const nested = kmlGeometry(multi);
    if (nested?.type === 'GeometryCollection') parts.push(...(nested.geometries as Record<string, unknown>[]));
    else if (nested) parts.push(nested);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : { type: 'GeometryCollection', geometries: parts };
}

/** `lon,lat[,alt] lon,lat[,alt] …` */
function kmlCoordinates(value: unknown): Position[] {
  const raw = text(value);
  if (!raw) return [];
  return raw.trim().split(/\s+/)
    .map((tuple) => parsePosition(tuple.split(',')))
    .filter(Boolean) as Position[];
}

// MARK: - GPX

function readGpx(gpx: any): Feature[] {
  if (!gpx) throw new Error('kein <gpx>-Element');
  const features: Feature[] = [];

  for (const waypoint of list(gpx.wpt)) {
    const position = gpxPosition(waypoint);
    if (!position) continue;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: position }, properties: gpxProperties(waypoint, 'Wegpunkt') });
  }
  for (const route of list(gpx.rte)) {
    const positions = list(route.rtept).map(gpxPosition).filter(Boolean) as Position[];
    if (positions.length > 1) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: positions }, properties: gpxProperties(route, 'Route') });
    }
  }
  for (const track of list(gpx.trk)) {
    const segments = list(track.trkseg)
      .map((segment: any) => list(segment.trkpt).map(gpxPosition).filter(Boolean) as Position[])
      .filter((segment) => segment.length > 1);
    if (segments.length === 0) continue;
    const properties = gpxProperties(track, 'Track');
    const times = list(track.trkseg).flatMap((segment: any) => list(segment.trkpt).map((point: any) => text(point.time))).filter(Boolean) as string[];
    if (times.length) {
      properties.start = times[0];
      properties.ende = times[times.length - 1];
    }
    properties.punkte = segments.reduce((sum, segment) => sum + segment.length, 0);
    features.push({
      type: 'Feature',
      geometry: segments.length === 1
        ? { type: 'LineString', coordinates: segments[0] }
        : { type: 'MultiLineString', coordinates: segments },
      properties,
    });
  }
  return features;
}

function gpxPosition(point: any): Position | null {
  const position = parsePosition([attr(point, 'lon'), attr(point, 'lat')]);
  if (!position) return null;
  const elevation = Number(text(point.ele));
  return Number.isFinite(elevation) && text(point.ele) !== undefined ? [position[0], position[1], elevation] : position;
}

function gpxProperties(element: any, kind: string): Record<string, unknown> {
  const properties: Record<string, unknown> = { art: kind };
  for (const key of ['name', 'desc', 'cmt', 'type', 'time', 'sym']) {
    const value = text(element[key]);
    if (value !== undefined) properties[key === 'desc' ? 'beschreibung' : key] = value;
  }
  const elevation = text(element.ele);
  if (elevation !== undefined) properties.hoehe = Number(elevation);
  return properties;
}

// MARK: - Helpers

function parsePosition(parts: Array<string | undefined>): Position | null {
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || parts[0] === '' || parts[1] === '') return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const alt = parts[2] === undefined || parts[2] === '' ? NaN : Number(parts[2]);
  return Number.isFinite(alt) ? [lon, lat, alt] : [lon, lat];
}

function list<T = any>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(element: any, name: string): string | undefined {
  const value = element?.[`@${name}`];
  return value === undefined ? undefined : String(value);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    return inner === undefined ? undefined : String(inner).trim();
  }
  return String(value).trim();
}
