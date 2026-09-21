import type { BrowserExtensionConnection } from '../services/browserExtension';

export interface BrowserExtensionCopy {
  label: string;
  detail: string;
}

export function browserExtensionCopy(status: BrowserExtensionConnection): BrowserExtensionCopy {
  switch (status.state) {
    case 'connected':
      return {
        label: 'Extension verbunden',
        detail: `Browser Extension verbunden · ${status.endpoint}`,
      };
    case 'listening':
      return {
        label: 'Extension bereit',
        detail: `Import-Bridge hört auf ${status.endpoint} und wartet auf die Browser Extension.`,
      };
    case 'conflict': {
      const owner = status.peer?.app ? ` (${status.peer.app})` : '';
      return {
        label: `Port ${status.port} belegt`,
        detail: `Die Import-Bridge kann Port ${status.port} nicht übernehmen${owner}.`,
      };
    }
    case 'offline':
      return {
        label: 'Extension offline',
        detail: status.error || `Import-Bridge auf Port ${status.port} ist nicht erreichbar.`,
      };
    case 'browser':
      return {
        label: 'Extension nur in App',
        detail: 'Die Browser Extension verbindet sich mit der nativen Vektor-App.',
      };
    default:
      return {
        label: 'Extension prüfen…',
        detail: 'Verbindung zur Browser Extension wird geprüft.',
      };
  }
}
