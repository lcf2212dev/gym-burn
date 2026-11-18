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
      CREATE TABLE IF NOT EXISTS workouts (id TEXT PRIMARY KEY, started INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  return database;
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
