/**
 * Global bot maintenance flag (global_maintenance_flags.key = 'bot').
 * Bot process stays online; handlers skip work while active.
 */
const { supabase } = require('../core/database');

let cache = { at: 0, active: false, reason: null };
const TTL_MS = 5_000;

async function refreshBotMaintenanceStatus() {
  try {
    const { data, error } = await supabase
      .from('global_maintenance_flags')
      .select('is_active, reason')
      .eq('key', 'bot')
      .maybeSingle();

    if (error) {
      console.error('[maintenanceGate] select failed', error.message);
      cache = { at: Date.now(), active: false, reason: null };
      return cache;
    }

    cache = {
      at: Date.now(),
      active: Boolean(data?.is_active),
      reason: data?.reason || null,
    };
    return cache;
  } catch (err) {
    console.error('[maintenanceGate] unexpected', err.message);
    cache = { at: Date.now(), active: false, reason: null };
    return cache;
  }
}

async function isBotMaintenanceActive() {
  if (Date.now() - cache.at < TTL_MS) return cache.active;
  const next = await refreshBotMaintenanceStatus();
  return next.active;
}

/** True when bot work must pause (emergency stop or bot maintenance). */
async function isBotWorkPaused() {
  try {
    const { isIncidentActive } = require('./incidentGate');
    if (await isIncidentActive()) return true;
  } catch {
    /* non-fatal */
  }
  return isBotMaintenanceActive();
}

async function getBotMaintenanceStatus() {
  if (Date.now() - cache.at >= TTL_MS) {
    await refreshBotMaintenanceStatus();
  }
  return { isMaintenance: cache.active, reason: cache.reason };
}

function invalidateMaintenanceGate() {
  cache = { at: 0, active: false, reason: null };
}

function setMaintenanceGateActive(active, reason = null) {
  cache = { at: Date.now(), active: Boolean(active), reason: reason || null };
}

module.exports = {
  isBotMaintenanceActive,
  isBotWorkPaused,
  getBotMaintenanceStatus,
  invalidateMaintenanceGate,
  setMaintenanceGateActive,
  refreshBotMaintenanceStatus,
};
