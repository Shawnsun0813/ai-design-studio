// Workbench ↔ session server. The UI only reads the server's snapshot (event-store projection) and sends commands;
// it never decides state transitions itself.
import { useEffect, useState } from 'react';

export type Role = 'pm' | 'ref' | 'lead' | 'visual' | 'impl' | 'review' | 'exec';
export type Status = 'running' | 'waiting_dep' | 'waiting_user' | 'done' | 'returned' | 'failed' | 'cancelled' | 'stale';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export type Instance = { id: string; model?: string; promptVersion?: string; attempt?: number; startedAt?: string; endedAt?: string; status?: string; usd?: number; usdUnknown?: boolean; usage?: Json; ms?: number; code?: string };
export type Task = {
  id: string; role: Role; node: string; title: string; kind?: string; status: Status; action?: string; round: number; epoch: number;
  region: string; version: string; inputs: string[]; artifacts: string[]; instances: Instance[]; handoffTo?: string; returnReason?: string[];
  createdAt: string; startedAt?: string; endedAt?: string; attempts: number; code?: string;
};
export type Ev = { seq: number; ts: string; type: string; taskId?: string; role?: string; instanceId?: string; round: number; epoch: number; payload?: Json };
export type Waiting = { seq: number; taskId?: string; kind: string; prompt: string; options: string[]; refs: Json; epoch: number };
export type Version = { label: string; kind: string; files: Json; hash: string; seq: number; ts: string; round: number };
export type State = {
  session: { id: string; operator: string; modelMode: string; model: string; startedAt: string; target: Json } | null;
  region: { regionId: string; component: string; sourceFile: string; allowedFiles: string[]; preserve: string[]; element?: string; label: string } | null;
  brief: { goal: string; referenceId: string | null; referenceName: string | null; noReference: boolean; seq: number } | null;
  round: number; epoch: number; tasks: Record<string, Task>; order: string[];
  decisions: Json[]; versions: Version[];
  artifacts: Record<string, { id: string; kind: string; taskId?: string; round: number; epoch: number; version?: string; title?: string; seq: number; mode?: string; cycle?: string }>;
  waiting: Waiting | null; interpretations: { id: string; version: number; stale: boolean; confirmed: boolean }[];
  latest: Record<string, string>; applies: Json[]; reviews: Json[]; techChecks: Json[]; roundStarts: Record<string, Json>; cancels: Json[];
  adoptions: Json[]; restores: Json[]; restoreFailures: Json[]; running: Version | null; adopted: Json; applied: Json; review: Json; techCheck: Json; restored: Json;
  cancelled: Json; closed: Json; failure: Json; notes: Json[];
  cost: { knownUsd: number; calls: number; unknownCalls: number; unknownWorstUsd: number }; stale: number;
  busy: boolean; status: 'none' | 'pick-region' | 'brief' | 'idle' | 'running' | 'waiting' | 'failed' | 'cancelled' | 'closed';
};
export type LedgerSummary = { calls: number; knownUsd: number; unknownCalls: number; unknownWorstUsd: number; countedUsd: number };
export type Snapshot = {
  sessionId?: string; state?: State; events?: Ev[]; artifacts?: Record<string, { id: string; kind: string; data: Json; [k: string]: Json }>;
  pageVersion?: { files: Json; hash: string; short: string } | null; running?: boolean;
  ledger: { tranche: LedgerSummary; session?: LedgerSummary }; caps?: { tranche: number; session: number }; limits?: Json;
  modelMode: string; operators?: Record<string, string>; connection?: { reachable: boolean; url: string }; registry?: Json; now?: string;
  code?: { short: string; hash: string; files: number; startedAt: string };
};

export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let es: EventSource | null = null;
    let stop = false;
    const open = () => {
      // Keep the connection in a local so a late error from a replaced EventSource cannot close the live one
      // (that flapped the "lost connection" banner back on right after a reconnect).
      const cur = new EventSource('/api/stream');
      es = cur;
      cur.onmessage = (e) => { if (es !== cur) return; setSnap(JSON.parse(e.data)); setOnline(true); };
      cur.onerror = () => { cur.close(); if (es !== cur) return; setOnline(false); if (!stop) setTimeout(open, 1500); };
    };
    open();
    return () => { stop = true; es?.close(); };
  }, []);
  return { snap, online };
}

export type CmdResult = { ok: boolean; code?: string; message?: string };
export async function send(snap: Snapshot | null, cmd: Record<string, unknown>): Promise<CmdResult> {
  const st = snap?.state;
  const body = { epoch: st?.epoch, waitSeq: st?.waiting?.seq, ...cmd };
  const r = await fetch('/api/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export const fileUrl = (snap: Snapshot | null, name: string) => `/api/files/${snap?.sessionId}/${name}`;
export const hhmmss = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '');
export const usd = (x?: number) => `$${(x ?? 0).toFixed(4)}`;
