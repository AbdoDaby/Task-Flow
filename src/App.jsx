import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// DATABASE SCHEMA (PostgreSQL / Prisma)
// ============================================================
/*
-- schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String
  createdAt     DateTime  @default(now())
  tasks         Task[]
  schedules     Schedule[]
}

model Task {
  id            String    @id @default(cuid())
  userId        String
  title         String
  description   String?
  startTime     DateTime
  endTime       DateTime
  completed     Boolean   @default(false)
  completedAt   DateTime?
  category      String    @default("general")
  priority      String    @default("medium") // low | medium | high
  color         String    @default("#4A90D9")
  reminder      Boolean   @default(true)
  reminderSent  Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  user          User      @relation(fields: [userId], references: [id])
}

model Schedule {
  id            String    @id @default(cuid())
  userId        String
  date          DateTime
  busySlots     Json      // [{start: "09:00", end: "10:00"}, ...]
  freeSlots     Json      // [{start: "10:00", end: "12:00"}, ...]
  createdAt     DateTime  @default(now())
  user          User      @relation(fields: [userId], references: [id])
}

-- SQL equivalent:
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  category TEXT DEFAULT 'general',
  priority TEXT DEFAULT 'medium',
  color TEXT DEFAULT '#4A90D9',
  reminder BOOLEAN DEFAULT TRUE,
  reminder_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id),
  date DATE NOT NULL,
  busy_slots JSONB,
  free_slots JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Indexes for performance:
CREATE INDEX idx_tasks_user_date ON tasks(user_id, start_time);
CREATE INDEX idx_tasks_reminder ON tasks(reminder, reminder_sent, start_time);
CREATE INDEX idx_schedules_user_date ON schedules(user_id, date);
*/

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function checkConflict(tasks, newStart, newEnd, excludeId = null) {
  return tasks
    .filter((t) => t.id !== excludeId)
    .some((t) => {
      const tStart = t.startTime.getTime();
      const tEnd = t.endTime.getTime();
      const nStart = newStart.getTime();
      const nEnd = newEnd.getTime();
      return nStart < tEnd && nEnd > tStart;
    });
}

function getFreeSlots(tasks, dateStr, dayStart = 8, dayEnd = 22) {
  const dayTasks = tasks
    .filter((t) => t.startTime.toISOString().split("T")[0] === dateStr)
    .sort((a, b) => a.startTime - b.startTime);

  const free = [];
  let cursor = dayStart * 60;

  for (const t of dayTasks) {
    const tStart = minutesSinceMidnight(t.startTime);
    const tEnd = minutesSinceMidnight(t.endTime);
    if (tStart > cursor) {
      free.push({ start: cursor, end: tStart });
    }
    cursor = Math.max(cursor, tEnd);
  }

  if (cursor < dayEnd * 60) {
    free.push({ start: cursor, end: dayEnd * 60 });
  }

  return free;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ============================================================
// AI CHAT LOGIC - Natural Language Parser
// ============================================================

async function parseTaskFromNL(message, tasks, selectedDate) {
  // Simulate AI parsing - in production this calls Claude API
  const lower = message.toLowerCase();

  // Time patterns
  const timeRegex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  const times = [];
  let m;
  while ((m = timeRegex.exec(lower)) !== null) {
    let hour = parseInt(m[1]);
    const min = parseInt(m[2] || "0");
    const ampm = m[3];
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    times.push({ hour, min });
  }

  // Date parsing
  let targetDate = new Date(selectedDate);
  if (lower.includes("tomorrow")) {
    targetDate = new Date(selectedDate);
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (lower.includes("next week")) {
    targetDate = new Date(selectedDate);
    targetDate.setDate(targetDate.getDate() + 7);
  }

  // Duration
  const durMatch = lower.match(/(\d+)\s*(hour|hr|minute|min)/);
  const durationMins = durMatch
    ? durMatch[2].startsWith("h") ? parseInt(durMatch[1]) * 60 : parseInt(durMatch[1])
    : 60;

  // Title extraction - remove time/date words
  let title = message
    .replace(/schedule|add|create|set up|book|remind me to/gi, "")
    .replace(/tomorrow|today|next week/gi, "")
    .replace(/at \d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, "")
    .replace(/for \d+ (?:hour|hr|minute|min)s?/gi, "")
    .trim();

  if (!title) title = "New Task";
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Category detection
  let category = "general";
  if (/meeting|call|standup|sync|review|client/i.test(title)) category = "work";
  if (/gym|exercise|workout|run|yoga|health|doctor/i.test(title)) category = "health";
  if (/lunch|dinner|breakfast|coffee|birthday|party/i.test(title)) category = "personal";

  if (times.length === 0) {
    return { success: false, message: "I couldn't detect a time. Try: 'Schedule a meeting tomorrow at 3 PM'" };
  }

  const { hour, min } = times[0];
  const startTime = new Date(targetDate);
  startTime.setHours(hour, min, 0, 0);
  const endTime = new Date(startTime.getTime() + durationMins * 60000);

  const dateStr = targetDate.toISOString().split("T")[0];
  const hasConflict = checkConflict(tasks, startTime, endTime);
  const freeSlots = getFreeSlots(tasks, dateStr);

  if (hasConflict) {
    const suggestions = freeSlots
      .filter((s) => s.end - s.start >= durationMins)
      .slice(0, 3)
      .map((s) => `${minutesToTime(s.start)} – ${minutesToTime(Math.min(s.end, s.start + durationMins))}`);
    return {
      success: false,
      conflict: true,
      message: `⚠️ That time slot is already taken! Available slots: ${suggestions.join(", ")}`,
    };
  }

  const colors = { work: "#4A90D9", health: "#5BB97B", personal: "#7C5CBF", general: "#94A3B8" };
  const newTask = {
    id: generateId(),
    title,
    description: `Added via AI assistant`,
    startTime,
    endTime,
    completed: false,
    category,
    priority: "medium",
    color: colors[category],
    reminder: true,
    reminderSent: false,
  };

  return {
    success: true,
    task: newTask,
    message: `✅ Added "${title}" on ${targetDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} from ${formatTime(startTime)} to ${formatTime(endTime)}`,
  };
}

// ============================================================
// NOTIFICATION SYSTEM
// ============================================================

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendNotification(task) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`⏰ Starting in 15 min: ${task.title}`, {
      body: `${formatTime(task.startTime)} – ${task.description || ""}`,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: task.id,
    });
  }
}

function checkReminders(tasks, setTasks) {
  const now = new Date();
  const updated = tasks.map((task) => {
    if (task.completed || task.reminderSent || !task.reminder) return task;
    const msUntil = task.startTime.getTime() - now.getTime();
    const minsUntil = msUntil / 60000;
    if (minsUntil > 0 && minsUntil <= 15) {
      sendNotification(task);
      return { ...task, reminderSent: true };
    }
    return task;
  });
  setTasks(updated);
}

// ============================================================
// COMPONENTS
// ============================================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const CATEGORIES = {
  work: { label: "Work", color: "#4A90D9" },
  health: { label: "Health", color: "#5BB97B" },
  personal: { label: "Personal", color: "#7C5CBF" },
  general: { label: "General", color: "#94A3B8" },
};

// Helper to generate unique IDs (for new tasks before saving to DB)
const generateId = () => Math.random().toString(36).substr(2, 9);

// -- Styles injected globally
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  :root {
    --bg: #F4F1EC;
    --surface: #FFFFFF;
    --surface2: #F9F7F4;
    --border: #E8E2DA;
    --text: #1C2B3A;
    --text-muted: #7A8899;
    --accent: #3A7BD5;
    --accent-light: #EBF2FF;
    --green: #3D8F5F;
    --green-light: #E8F5EE;
    --amber: #D4820E;
    --amber-light: #FEF3E2;
    --shadow: 0 2px 16px rgba(28,43,58,0.08);
    --shadow-lg: 0 8px 40px rgba(28,43,58,0.14);
    --radius: 14px;
    --radius-sm: 8px;
  }

  body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text); }

  .app-shell { display: flex; height: 100vh; overflow: hidden; }

  /* Sidebar */
  .sidebar {
    width: 220px; min-width: 220px; background: var(--text);
    display: flex; flex-direction: column; padding: 24px 16px;
    gap: 4px; overflow-y: auto;
  }
  .sidebar-logo {
    font-family: 'DM Serif Display', serif; color: white;
    font-size: 22px; padding: 0 8px 20px; letter-spacing: -0.5px;
  }
  .sidebar-logo span { color: #5BB97B; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: var(--radius-sm); cursor: pointer; color: #8FA3B8;
    font-size: 14px; font-weight: 500; transition: all 0.15s; border: none;
    background: transparent; width: 100%; text-align: left;
  }
  .nav-item:hover { background: rgba(255,255,255,0.08); color: white; }
  .nav-item.active { background: rgba(58,123,213,0.25); color: #7BB8FF; }
  .nav-icon { font-size: 16px; width: 20px; text-align: center; }
  .nav-section { font-size: 10px; color: #4A6070; letter-spacing: 1px; text-transform: uppercase; padding: 16px 12px 6px; }

  /* Main content */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .topbar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 16px 28px; display: flex; align-items: center; justify-content: space-between;
    gap: 16px;
  }
  .page-title { font-family: 'DM Serif Display', serif; font-size: 26px; letter-spacing: -0.5px; }
  .date-badge {
    font-size: 13px; color: var(--text-muted); background: var(--surface2);
    padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border);
  }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px;
    border-radius: var(--radius-sm); border: none; cursor: pointer; font-size: 14px;
    font-weight: 500; font-family: inherit; transition: all 0.15s;
  }
  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { background: #2d69c4; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(58,123,213,0.3); }
  .btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--surface2); color: var(--text); }

  /* Content area */
  .content-area { flex: 1; overflow-y: auto; padding: 24px 28px; display: flex; gap: 24px; }

  /* Calendar View */
  .timeline-wrap { flex: 1; background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; display: flex; flex-direction: column; }
  .timeline-header { padding: 18px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .timeline-scroll { flex: 1; overflow-y: auto; position: relative; }
  .timeline-inner { display: flex; }
  .time-gutter { width: 60px; min-width: 60px; }
  .time-label { height: 60px; display: flex; align-items: flex-start; padding: 4px 8px 0 0; font-size: 11px; color: var(--text-muted); text-align: right; }
  .slots-col { flex: 1; position: relative; }
  .slot-row { height: 60px; border-bottom: 1px solid var(--border); position: relative; }
  .slot-row.half { border-bottom: 1px dashed rgba(0,0,0,0.06); height: 30px; }
  .task-block {
    position: absolute; left: 4px; right: 4px; border-radius: var(--radius-sm);
    padding: 6px 10px; overflow: hidden; cursor: pointer; transition: all 0.2s;
    border-left: 3px solid rgba(255,255,255,0.4);
  }
  .task-block:hover { transform: translateX(2px); filter: brightness(1.05); box-shadow: var(--shadow); }
  .task-block.completed { opacity: 0.5; }
  .task-block-title { font-size: 13px; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task-block-time { font-size: 11px; color: rgba(255,255,255,0.8); }
  .free-slot { 
    background: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(91,185,123,0.06) 4px, rgba(91,185,123,0.06) 8px);
    border: 1px dashed rgba(91,185,123,0.3); border-radius: 4px; margin: 2px 4px;
  }

  /* Right panel */
  .right-panel { width: 320px; min-width: 320px; display: flex; flex-direction: column; gap: 20px; }

  /* Task card */
  .task-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px;
  }
  .task-card-header { font-size: 13px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 12px; }
  .task-item {
    display: flex; align-items: flex-start; gap: 12px; padding: 10px 0;
    border-bottom: 1px solid var(--border); transition: all 0.2s;
  }
  .task-item:last-child { border-bottom: none; }
  .task-check {
    width: 20px; height: 20px; min-width: 20px; border-radius: 50%;
    border: 2px solid var(--border); cursor: pointer; display: flex;
    align-items: center; justify-content: center; transition: all 0.2s; margin-top: 1px;
    background: white;
  }
  .task-check:hover { border-color: var(--green); }
  .task-check.checked { background: var(--green); border-color: var(--green); animation: checkPop 0.3s cubic-bezier(0.34,1.56,0.64,1); }
  @keyframes checkPop { 0% { transform: scale(0.5); } 70% { transform: scale(1.2); } 100% { transform: scale(1); } }
  .task-info { flex: 1; min-width: 0; }
  .task-title { font-size: 14px; font-weight: 500; transition: all 0.3s; }
  .task-title.completed { text-decoration: line-through; color: var(--text-muted); }
  .task-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .priority-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }

  .task-delete {
    opacity: 0;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .task-item:hover .task-delete { opacity: 1; }
  .task-delete:hover { color: #E8505B; background: #FEE2E2; }

  /* AI Chat */
  .ai-chat {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); display: flex; flex-direction: column; height: 380px;
  }
  .chat-header { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .ai-avatar { width: 32px; height: 32px; background: linear-gradient(135deg, #3A7BD5, #7C5CBF); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .chat-title { font-weight: 600; font-size: 14px; }
  .chat-status { font-size: 11px; color: var(--green); }
  .chat-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 90%; }
  .msg.ai { align-self: flex-start; }
  .msg.user { align-self: flex-end; }
  .msg-bubble {
    padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 1.5;
  }
  .msg.ai .msg-bubble { background: var(--surface2); border: 1px solid var(--border); border-radius: 14px 14px 14px 4px; }
  .msg.user .msg-bubble { background: var(--accent); color: white; border-radius: 14px 14px 4px 14px; }
  .chat-input-row { padding: 10px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  .chat-input {
    flex: 1; border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 9px 12px; font-size: 13px; font-family: inherit; background: var(--surface2);
    color: var(--text); outline: none; resize: none;
  }
  .chat-input:focus { border-color: var(--accent); background: white; }
  .chat-send { width: 36px; height: 36px; border-radius: var(--radius-sm); background: var(--accent); border: none; color: white; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
  .chat-send:hover { background: #2d69c4; }

  /* Analytics */
  .analytics-wrap { padding: 24px 28px; overflow-y: auto; }
  .analytics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .stat-value { font-family: 'DM Serif Display', serif; font-size: 32px; }
  .stat-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  .chart-title { font-weight: 600; font-size: 15px; margin-bottom: 16px; }

  /* Bar chart */
  .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 120px; }
  .bar-group { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .bar-fill { width: 100%; border-radius: 4px 4px 0 0; background: var(--accent); transition: height 0.5s cubic-bezier(0.34,1.2,0.64,1); min-height: 2px; }
  .bar-label { font-size: 11px; color: var(--text-muted); }

  /* Donut */
  .donut-wrap { display: flex; align-items: center; gap: 20px; }
  .donut-legend { display: flex; flex-direction: column; gap: 8px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }

  /* Notification toast */
  .toast-wrap { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
  .toast {
    background: var(--text); color: white; border-radius: var(--radius-sm);
    padding: 14px 18px; font-size: 13px; box-shadow: var(--shadow-lg);
    max-width: 320px; animation: toastIn 0.3s ease;
    display: flex; gap: 10px; align-items: flex-start; pointer-events: all;
  }
  @keyframes toastIn { from { transform: translateX(60px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  .toast-icon { font-size: 16px; }
  .toast-body { flex: 1; }
  .toast-title { font-weight: 600; margin-bottom: 2px; }
  .toast-msg { font-size: 12px; color: #8FA3B8; }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(28,43,58,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
  .modal { background: var(--surface); border-radius: var(--radius); width: 440px; max-width: 95vw; box-shadow: var(--shadow-lg); overflow: hidden; animation: modalIn 0.25s cubic-bezier(0.34,1.2,0.64,1); }
  @keyframes modalIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .modal-header { padding: 20px 24px; border-bottom: 1px solid var(--border); font-family: 'DM Serif Display', serif; font-size: 20px; }
  .modal-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }
  .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .form-input {
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px;
    font-size: 14px; font-family: inherit; color: var(--text); background: var(--surface2);
    outline: none; transition: border 0.15s;
  }
  .form-input:focus { border-color: var(--accent); background: white; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  /* Availability bands */
  .avail-legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); padding: 8px 0; }
  .avail-badge { display: flex; align-items: center; gap: 5px; }
  .avail-dot { width: 10px; height: 10px; border-radius: 2px; }

  /* Tab bar */
  .tab-bar { display: flex; gap: 2px; background: var(--surface2); border-radius: var(--radius-sm); padding: 3px; }
  .tab { padding: 7px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--text-muted); border: none; background: transparent; transition: all 0.15s; font-family: inherit; }
  .tab.active { background: white; color: var(--text); box-shadow: 0 1px 4px rgba(0,0,0,0.1); }

  /* Notification bell */
  .notif-bell { position: relative; }
  .notif-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; background: #E8505B; border-radius: 50%; border: 2px solid white; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }

  /* Responsive */
  @media (max-width: 768px) {
    .sidebar { display: none; }
    .content-area { flex-direction: column; padding: 16px; }
    .right-panel { width: 100%; min-width: 0; }
    .analytics-grid { grid-template-columns: repeat(2, 1fr); }
    .charts-row { grid-template-columns: 1fr; }
  }

  .completion-flash { animation: flashGreen 0.6s ease; }
  @keyframes flashGreen { 0% { background: var(--green-light); } 100% { background: transparent; } }
`;

// ============================================================
// TIMELINE COMPONENT
// ============================================================

function Timeline({ tasks, selectedDate, onToggleComplete, onTaskClick }) {
  const dateStr = selectedDate.toISOString().split("T")[0];
  const dayTasks = tasks.filter(
    (t) => t.startTime.toISOString().split("T")[0] === dateStr
  );
  const freeSlots = getFreeSlots(tasks, dateStr);
  const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am - 9pm
  const DAY_START_MIN = 7 * 60;
  const HOUR_HEIGHT = 60;

  const getTaskStyle = (task) => {
    const startMin = minutesSinceMidnight(task.startTime) - DAY_START_MIN;
    const durMin = (task.endTime - task.startTime) / 60000;
    return {
      top: `${(startMin / 60) * HOUR_HEIGHT}px`,
      height: `${Math.max((durMin / 60) * HOUR_HEIGHT, 28)}px`,
      backgroundColor: task.color,
    };
  };

  return (
    <div className="timeline-wrap">
      <div className="timeline-header">
        <span style={{ fontSize: 15, fontWeight: 600 }}>📅 Daily Schedule</span>
        <div className="avail-legend">
          <div className="avail-badge"><div className="avail-dot" style={{ background: "#3A7BD5" }} />Busy</div>
          <div className="avail-badge"><div className="avail-dot" style={{ background: "rgba(91,185,123,0.3)", border: "1px dashed #5BB97B" }} />Free</div>
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner">
          <div className="time-gutter">
            {HOURS.map((h) => (
              <div key={h} className="time-label">
                {h.toString().padStart(2, "0")}:00
              </div>
            ))}
          </div>
          <div className="slots-col" style={{ height: `${HOURS.length * HOUR_HEIGHT}px` }}>
            {HOURS.map((h) => (
              <div key={h} className="slot-row" />
            ))}
            {/* Free slots */}
            {freeSlots.map((slot, i) => {
              const top = ((slot.start - DAY_START_MIN) / 60) * HOUR_HEIGHT;
              const h = ((slot.end - slot.start) / 60) * HOUR_HEIGHT;
              if (top < 0 || h <= 0) return null;
              return (
                <div
                  key={i}
                  className="free-slot"
                  style={{ position: "absolute", top: `${top}px`, height: `${Math.max(h, 4)}px`, left: 4, right: 4 }}
                />
              );
            })}
            {/* Task blocks */}
            {dayTasks.map((task) => (
              <div
                key={task.id}
                className={`task-block ${task.completed ? "completed" : ""}`}
                style={getTaskStyle(task)}
                onClick={() => onTaskClick(task)}
              >
                <div className="task-block-title">{task.completed ? "✓ " : ""}{task.title}</div>
                <div className="task-block-time">{formatTime(task.startTime)} – {formatTime(task.endTime)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TASK LIST COMPONENT
// ============================================================

function TaskList({ tasks, onToggle, onDelete }) {
  const PRIORITY_COLORS = { high: "#E8505B", medium: "#E8A838", low: "#5BB97B" };

  return (
    <div className="task-card">
      <div className="task-card-header">Today's Tasks</div>
      {tasks.length === 0 && (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: 14 }}>
          No tasks yet. Add one! ✨
        </div>
      )}
      {tasks.map((task) => (
        <div key={task.id} className={`task-item ${task.completed ? "completion-flash" : ""}`}>
          <div
            className={`task-check ${task.completed ? "checked" : ""}`}
            onClick={() => onToggle(task.id)}
          >
            {task.completed && <span style={{ fontSize: 11, color: "white" }}>✓</span>}
          </div>
          <div className="priority-dot" style={{ background: PRIORITY_COLORS[task.priority] }} />
          <div className="task-info">
            <div className={`task-title ${task.completed ? "completed" : ""}`}>{task.title}</div>
            <div className="task-meta">{formatTime(task.startTime)} – {formatTime(task.endTime)} · {CATEGORIES[task.category]?.label}</div>
          </div>
          <button
            className="task-delete"
            onClick={() => onDelete(task.id)}
            title="Delete task"
          >
            🗑️
          </button>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// AI CHAT COMPONENT
// ============================================================

function AIChat({ tasks, onAddTask, selectedDate, addToast }) {
  const [messages, setMessages] = useState([
    { id: "1", role: "ai", text: "Hi! I'm your AI planning assistant 🤖\nTry: \"Schedule a team meeting tomorrow at 2 PM for 1 hour\"" },
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || thinking) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((m) => [...m, { id: Math.random().toString(36).substr(2, 9), role: "user", text: userMsg }]);
    setThinking(true);

    await new Promise((r) => setTimeout(r, 700));

    const result = await parseTaskFromNL(userMsg, tasks, selectedDate);
    setThinking(false);

    if (result.success && result.task) {
      await onAddTask(result.task);
      addToast("✅ Task Added", result.message, "success");
    }

    setMessages((m) => [...m, { id: Math.random().toString(36).substr(2, 9), role: "ai", text: result.message }]);
  };

  return (
    <div className="ai-chat">
      <div className="chat-header">
        <div className="ai-avatar">🤖</div>
        <div>
          <div className="chat-title">AI Planner</div>
          <div className="chat-status">● Online</div>
        </div>
      </div>
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`msg ${msg.role}`}>
            <div className="msg-bubble" style={{ whiteSpace: "pre-line" }}>{msg.text}</div>
          </div>
        ))}
        {thinking && (
          <div className="msg ai">
            <div className="msg-bubble" style={{ color: "var(--text-muted)" }}>Thinking…</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          placeholder='e.g. "Schedule a meeting tomorrow at 3 PM"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
        />
        <button className="chat-send" onClick={handleSend}>➤</button>
      </div>
    </div>
  );
}

// ============================================================
// ANALYTICS DASHBOARD
// ============================================================

function Analytics({ tasks }) {
  const todayStr2 = new Date().toISOString().split("T")[0];
  const todayTasks = tasks.filter((t) => t.startTime.toISOString().split("T")[0] === todayStr2);
  const completed = todayTasks.filter((t) => t.completed).length;
  const total = todayTasks.length;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Mock weekly data
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekData = [3, 5, 4, 6, completed, 2, 0];
  const maxVal = Math.max(...weekData, 1);

  // Category breakdown
  const catBreakdown = Object.entries(CATEGORIES).map(([key, val]) => ({
    ...val,
    key,
    count: tasks.filter((t) => t.category === key).length,
  })).filter((c) => c.count > 0);
  const totalCats = catBreakdown.reduce((s, c) => s + c.count, 0);

  // Donut SVG
  const DonutChart = () => {
    const r = 48, cx = 56, cy = 56, stroke = 22;
    const circ = 2 * Math.PI * r;
    let cumulative = 0;
    const colors = ["#4A90D9", "#7C5CBF", "#5BB97B", "#94A3B8"];
    const segments = catBreakdown.map((c, i) => {
      const frac = totalCats > 0 ? c.count / totalCats : 0;
      const dashOffset = circ * (1 - cumulative);
      cumulative += frac;
      return { ...c, frac, dashOffset, color: colors[i % colors.length] };
    });

    return (
      <svg width={112} height={112} viewBox="0 0 112 112">
        {segments.map((seg, i) => (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={seg.color}
            strokeWidth={stroke} strokeDasharray={`${seg.frac * circ} ${circ}`}
            strokeDashoffset={seg.dashOffset} transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke-dasharray 0.8s ease" }}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={18} fontWeight="bold" fill="#1C2B3A" fontFamily="DM Serif Display">{rate}%</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} fill="#7A8899">Done</text>
      </svg>
    );
  };

  return (
    <div className="analytics-wrap">
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: "DM Serif Display", fontSize: 28, marginBottom: 4 }}>Productivity Analytics</div>
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Track your progress and streaks</div>
      </div>
      <div className="analytics-grid">
        {[
          { label: "Tasks Today", value: total, icon: "📋", color: "#4A90D9" },
          { label: "Completed", value: completed, icon: "✅", color: "#5BB97B" },
          { label: "Completion Rate", value: `${rate}%`, icon: "📈", color: "#E8A838" },
          { label: "Weekly Streak", value: "4 🔥", icon: "🏆", color: "#E8505B" },
        ].map((s) => (
          <div key={s.label} className="stat-card">
            <div style={{ fontSize: 24, marginBottom: 6 }}>{s.icon}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="charts-row">
        <div className="chart-card">
          <div className="chart-title">📊 Weekly Completions</div>
          <div className="bar-chart">
            {days.map((day, i) => (
              <div key={day} className="bar-group">
                <div className="bar-fill" style={{
                  height: `${(weekData[i] / maxVal) * 100}px`,
                  background: i === 4 ? "#5BB97B" : "var(--accent)",
                  opacity: weekData[i] === 0 ? 0.2 : 1,
                }} />
                <div className="bar-label">{day}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-card">
          <div className="chart-title">🍩 By Category</div>
          <div className="donut-wrap">
            <DonutChart />
            <div className="donut-legend">
              {catBreakdown.map((c, i) => (
                <div key={c.key} className="legend-item">
                  <div className="legend-dot" style={{ background: ["#4A90D9", "#7C5CBF", "#5BB97B", "#94A3B8"][i % 4] }} />
                  <span>{c.label}: <strong>{c.count}</strong></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* Daily breakdown table */}
      <div className="chart-card" style={{ marginTop: 20 }}>
        <div className="chart-title">📅 Today's Task Details</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--border)" }}>
              {["Task", "Time", "Category", "Priority", "Status"].map((h) => (
                <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "var(--text-muted)", fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {todayTasks.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "10px", fontWeight: 500 }}>{t.title}</td>
                <td style={{ padding: "10px", color: "var(--text-muted)" }}>{formatTime(t.startTime)}</td>
                <td style={{ padding: "10px" }}><span style={{ background: "var(--surface2)", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>{CATEGORIES[t.category]?.label}</span></td>
                <td style={{ padding: "10px" }}>
                  <span style={{ color: t.priority === "high" ? "#E8505B" : t.priority === "medium" ? "#E8A838" : "#5BB97B", fontWeight: 600, fontSize: 12 }}>{t.priority.toUpperCase()}</span>
                </td>
                <td style={{ padding: "10px" }}>
                  <span style={{ background: t.completed ? "var(--green-light)" : "var(--amber-light)", color: t.completed ? "var(--green)" : "var(--amber)", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                    {t.completed ? "Done" : "Pending"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// ADD TASK MODAL
// ============================================================

function AddTaskModal({ tasks, onSave, onClose, selectedDate }) {
  const dateStr = selectedDate.toISOString().split("T")[0];
  const [form, setForm] = useState({
    title: "", description: "", date: dateStr,
    startTime: "09:00", endTime: "10:00",
    category: "work", priority: "medium", color: "#4A90D9", reminder: true,
  });
  const [conflict, setConflict] = useState(false);
  const freeSlots = getFreeSlots(tasks, form.date);

  const handleChange = (key, val) => {
    const updated = { ...form, [key]: val };
    setForm(updated);
    const start = new Date(`${updated.date}T${updated.startTime}`);
    const end = new Date(`${updated.date}T${updated.endTime}`);
    setConflict(start < end ? checkConflict(tasks, start, end) : false);
  };

  const handleSave = () => {
    if (!form.title.trim()) return;
    const start = new Date(`${form.date}T${form.startTime}`);
    const end = new Date(`${form.date}T${form.endTime}`);
    if (start >= end) return;
    onSave({
      id: generateId(), title: form.title, description: form.description,
      startTime: start, endTime: end, completed: false,
      category: form.category, priority: form.priority, color: form.color,
      reminder: form.reminder, reminderSent: false,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Add New Task</div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Title *</label>
            <input className="form-input" placeholder="What do you need to do?" value={form.title} onChange={(e) => handleChange("title", e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input className="form-input" placeholder="Optional details" value={form.description} onChange={(e) => handleChange("description", e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Date</label>
              <input type="date" className="form-input" value={form.date} onChange={(e) => handleChange("date", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Category</label>
              <select className="form-input" value={form.category} onChange={(e) => handleChange("category", e.target.value)}>
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Start Time</label>
              <input type="time" className="form-input" value={form.startTime} onChange={(e) => handleChange("startTime", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">End Time</label>
              <input type="time" className="form-input" value={form.endTime} onChange={(e) => handleChange("endTime", e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Priority</label>
              <select className="form-input" value={form.priority} onChange={(e) => handleChange("priority", e.target.value)}>
                <option value="low">🟢 Low</option>
                <option value="medium">🟡 Medium</option>
                <option value="high">🔴 High</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Color</label>
              <input type="color" className="form-input" value={form.color} onChange={(e) => handleChange("color", e.target.value)} style={{ height: 40, padding: 4 }} />
            </div>
          </div>
          {conflict && (
            <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#991B1B" }}>
              ⚠️ Time conflict detected! Free slots today:
              {freeSlots.map((s, i) => (
                <span key={i} style={{ marginLeft: 6, background: "var(--green-light)", color: "var(--green)", padding: "1px 6px", borderRadius: 4, fontSize: 12 }}>
                  {minutesToTime(s.start)}–{minutesToTime(s.end)}
                </span>
              ))}
            </div>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14 }}>
            <input type="checkbox" checked={form.reminder} onChange={(e) => handleChange("reminder", e.target.checked)} />
            🔔 Remind me 15 minutes before
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={conflict}>
            {conflict ? "⚠️ Conflict" : "Save Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function Toasts({ toasts }) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <div className="toast-icon">{t.icon}</div>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            <div className="toast-msg">{t.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [view, setView] = useState("calendar"); // calendar | analytics
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [toasts, setToasts] = useState([]);
  const [notifPermission, setNotifPermission] = useState("default");

  const addToast = useCallback((title, message, type = "info") => {
    const icons = { success: "✅", error: "❌", info: "ℹ️", reminder: "⏰" };
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, title, message, icon: icons[type] }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  // Constants
  const today = new Date();

  // Fetch tasks
  useEffect(() => {
    const fetchTasks = async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('startTime', { ascending: true });

      if (error) {
        addToast("Error", "Could not load tasks from Supabase", "error");
      } else {
        const formatted = data.map(t => ({
          ...t,
          startTime: new Date(t.startTime),
          endTime: new Date(t.endTime)
        }));
        setTasks(formatted);
      }
    };
    fetchTasks();
  }, [addToast]);

  // Request notification permission on mount
  useEffect(() => {
    if ("Notification" in window) {
      setNotifPermission(Notification.permission);
      if (Notification.permission === "default") {
        Notification.requestPermission().then((p) => setNotifPermission(p));
      }
    }
  }, []);

  // Check reminders every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setTasks((prev) => {
        let changed = false;
        const updated = prev.map((task) => {
          if (task.completed || task.reminderSent || !task.reminder) return task;
          const msUntil = task.startTime.getTime() - now.getTime();
          const minsUntil = msUntil / 60000;
          if (minsUntil > 0 && minsUntil <= 15) {
            sendNotification(task);
            addToast(`⏰ Starting Soon`, `"${task.title}" starts at ${formatTime(task.startTime)}`, "reminder");
            changed = true;
            return { ...task, reminderSent: true };
          }
          return task;
        });
        return changed ? updated : prev;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [addToast]);

  const handleToggleComplete = async (taskId) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    try {
      const { data, error } = await supabase
        .from('tasks')
        .update({ completed: !task.completed, completedAt: !task.completed ? new Date().toISOString() : null })
        .eq('id', taskId)
        .select()
        .single();

      if (error) throw error;

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...data, startTime: new Date(data.startTime), endTime: new Date(data.endTime) }
            : t
        )
      );
    } catch (err) {
      addToast("Error", "Could not update task in Supabase", "error");
    }
  };

  const handleAddTask = async (task) => {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .insert([{ ...task, startTime: task.startTime.toISOString(), endTime: task.endTime.toISOString() }])
        .select()
        .single();

      if (error) throw error;

      setTasks((prev) => [...prev, { ...data, startTime: new Date(data.startTime), endTime: new Date(data.endTime) }]);
      addToast("Task Added", `"${task.title}" added to Supabase`, "success");
    } catch (err) {
      addToast("Error", "Could not save task to Supabase", "error");
    }
  };

  const handleDeleteTask = async (taskId) => {
    try {
      const { error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', taskId);

      if (error) throw error;

      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      addToast("Task Deleted", "Removed from Supabase", "info");
    } catch (err) {
      addToast("Error", "Could not delete from Supabase", "error");
    }
  };

  const dateStr = selectedDate.toISOString().split("T")[0];
  const todayTasks = tasks.filter((t) => t.startTime.toISOString().split("T")[0] === dateStr);

  const NAV_ITEMS = [
    { id: "calendar", icon: "📅", label: "Today" },
    { id: "analytics", icon: "📊", label: "Analytics" },
  ];

  return (
    <>
      <style>{STYLES}</style>
      <div className="app-shell">
        {/* Sidebar */}
        <nav className="sidebar">
          <div className="sidebar-logo">Task<span>Flow</span></div>
          <div className="nav-section">Navigation</div>
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div className="nav-section" style={{ marginTop: "auto" }}>Info</div>
          <div style={{ padding: "10px 12px", fontSize: 12, color: "#4A6070", lineHeight: 1.6 }}>
            {notifPermission === "granted" ? "🔔 Notifications on" : "🔕 Notifications off"}
            <br />
            <span style={{ color: "#5BB97B" }}>{tasks.filter((t) => t.completed).length}</span> tasks done
          </div>
        </nav>

        {/* Main */}
        <div className="main">
          <div className="topbar">
            <div>
              <div className="page-title">
                {view === "calendar" ? "📅 My Schedule" : "📊 Analytics"}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>{formatDate(selectedDate)}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="tab-bar">
                <button className={`tab ${view === "calendar" ? "active" : ""}`} onClick={() => setView("calendar")}>📅 Calendar</button>
                <button className={`tab ${view === "analytics" ? "active" : ""}`} onClick={() => setView("analytics")}>📊 Analytics</button>
              </div>
              {view === "calendar" && (
                <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>+ Add Task</button>
              )}
            </div>
          </div>

          {/* Content */}
          {view === "calendar" ? (
            <div className="content-area">
              <Timeline tasks={tasks} selectedDate={selectedDate} onToggleComplete={handleToggleComplete} onTaskClick={() => { }} />
              <div className="right-panel">
                <TaskList tasks={todayTasks} onToggle={handleToggleComplete} onDelete={handleDeleteTask} />
                <AIChat tasks={tasks} onAddTask={handleAddTask} selectedDate={selectedDate} addToast={addToast} />
              </div>
            </div>
          ) : (
            <Analytics tasks={tasks} />
          )}
        </div>
      </div>

      {/* Modals */}
      {showAddModal && (
        <AddTaskModal
          tasks={tasks}
          onSave={handleAddTask}
          onClose={() => setShowAddModal(false)}
          selectedDate={selectedDate}
        />
      )}

      {/* Toasts */}
      <Toasts toasts={toasts} />
    </>
  );
}
