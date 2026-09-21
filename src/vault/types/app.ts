export type ActiveTab = 'keys' | 'console' | 'phasex' | 'server' | 'api';

export interface TabDefinition {
  id: ActiveTab;
  label: string;
}
