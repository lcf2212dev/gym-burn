import { openDatabaseSync } from 'expo-sqlite';
import type { SessionMode } from '@/treadmill/types';
import type { Plan, Profile, Workout } from './model';

let database: ReturnType<typeof openDatabaseSync>;
function db() {
  if (!database) {
    database = openDatabaseSync('gym-burn.db');
    database.execSync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS prepared (source TEXT PRIMARY KEY, day TEXT NOT NULL, profile TEXT NOT NULL, plan TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workouts (id TEXT PRIMARY KEY, started INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  return database;
}

/** Uma chamada à IA como ficou no diário: o que foi enviado, o que voltou e quanto demorou. */
export type AiCall = { id: number; at: number; kind: string; data: Record<string, unknown> };
const JOURNAL_SIZE = 200;

export function saveCall(kind: string, data: object) {
  const { lastInsertRowId } = db().runSync(
    'INSERT INTO ai_calls (at, kind, data) VALUES (?, ?, ?)',
    Date.now(),
    kind,
    JSON.stringify(data),
  );
  db().runSync('DELETE FROM ai_calls WHERE id <= ?', lastInsertRowId - JOURNAL_SIZE);
}

export function readCalls(): AiCall[] {
  return db()
    .getAllSync<{ id: number; at: number; kind: string; data: string }>(
      'SELECT id, at, kind, data FROM ai_calls ORDER BY id DESC',
    )
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

/**
 * Apaga perfil, treinos, planos preparados e o diário da IA. A chave da
 * DeepSeek fica no armazenamento seguro do sistema, fora deste banco, e não é
 * tocada. A cinta de batimentos pareada (`settings`) também fica: é
 * equipamento, não dado de treino, e tem o seu próprio "Esquecer".
 */
export function clearData() {
  db().execSync(
    'DELETE FROM prepared; DELETE FROM profile; DELETE FROM workouts; DELETE FROM ai_calls;',
  );
}

export function deleteWorkout(id: string) {
  db().runSync('DELETE FROM workouts WHERE id = ?', id);
}

/**
 * Apaga os treinos de uma origem e o plano preparado para ela. Serve para
 * limpar as demonstrações sem tocar nos treinos da esteira real.
 */
export function clearSource(source: SessionMode) {
  const ids = readWorkouts()
    .filter((w) => w.source === source)
    .map((w) => w.id);
  for (const id of ids) db().runSync('DELETE FROM workouts WHERE id = ?', id);
  db().runSync('DELETE FROM prepared WHERE source = ?', source);
}

/** A cinta de batimentos pareada neste celular. */
export type SavedStrap = { id: string; name: string | null };

export function readStrap(): SavedStrap | null {
  const row = db().getFirstSync<{ value: string }>("SELECT value FROM settings WHERE key = 'strap'");
  return row ? JSON.parse(row.value) : null;
}

export function saveStrap(strap: SavedStrap | null) {
  if (strap) db().runSync("INSERT OR REPLACE INTO settings VALUES ('strap', ?)", JSON.stringify(strap));
  else db().runSync("DELETE FROM settings WHERE key = 'strap'");
}

export function readProfile(): Profile | null {
  const row = db().getFirstSync<{ data: string }>('SELECT data FROM profile WHERE id = 1');
  return row ? JSON.parse(row.data) : null;
}

export function saveProfile(profile: Profile) {
  db().runSync('INSERT OR REPLACE INTO profile VALUES (1, ?)', JSON.stringify(profile));
}

export function saveWorkout(w: Workout) {
  db().runSync(
    'INSERT OR REPLACE INTO workouts VALUES (?, ?, ?)',
    w.id,
    w.started,
    JSON.stringify(w),
  );
}

export function readWorkouts(): Workout[] {
  return db()
    .getAllSync<{ data: string }>('SELECT data FROM workouts ORDER BY started DESC')
    .map((row) => JSON.parse(row.data));
}

export function preparePlan(source: SessionMode, profile: Profile, plan: Plan) {
  db().runSync(
    'INSERT OR REPLACE INTO prepared VALUES (?, ?, ?, ?)',
    source,
    new Date().toDateString(),
    JSON.stringify(profile),
    JSON.stringify(plan),
  );
}

export function readPlan(source: SessionMode, profile: Profile | null): Plan | null {
  const row = db().getFirstSync<{ plan: string }>(
    'SELECT plan FROM prepared WHERE source = ? AND day = ? AND profile = ?',
    source,
    new Date().toDateString(),
    JSON.stringify(profile),
  );
  return row ? JSON.parse(row.plan) : null;
}
