export interface Task {
  id: string; clientId: string; profile: string; label: string; lastActivity: number; state: 'active' | 'finished';
}
export interface Observation {
  id: string; generation: number; authEpoch: number; url: string; title: string; snapshot: string;
  screenshot?: { width: number; height: number; scrollX: number; scrollY: number; fullPage: boolean };
}
export interface Tab {
  id: string; taskId?: string; targetId: string; page: any; cdp: any; generation: number;
  control: 'agent' | 'human'; humanScope?: 'tab' | 'identity' | 'browser'; humanSince?: number;
  handoff?: { id: string; status: string; reason?: string };
  observation?: Observation; title?: string; needsObservation: boolean; operationId?: string; operationMutates?: boolean; interrupted?: boolean; pendingHuman?: boolean;
  events: any[]; dialog?: any; fileChooser?: any; closed: boolean;
}
export interface BrowserRecord {
  id: string; profile: string; state: 'open' | 'recovering' | 'closing' | 'close_unconfirmed' | 'closed';
  browser?: any; context?: any; tabs: Map<string, Tab>; authEpoch: number;
  recording: boolean; lab: boolean; createdAt: number; lastSaveAt: number;
  checkpointError?: any; closeError?: any; connected: boolean;
}
export interface ClientRecord { id: string; pid: number; hostPid?: number; seenAt: number; label: string }
