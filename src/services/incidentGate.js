/**
 * Global system incident kill-switch for the Discord bot.
 * Cached briefly; cleared via POST /api/incident-sync.
 */
const { supabase } = require('../core/database');

let cache = { at: 0, active: false, message: null };
const TTL_MS = 5_000;

async function refreshIncidentStatus() {
  try {
    const { data, error } = await supabase
      .from('system_incident')
      .select('id,public_message,status')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[incidentGate] select failed', error.message);
      cache = { at: Date.now(), active: false, message: null };
      return cache;
    }

    cache = {
      at: Date.now(),
      active: Boolean(data),
      message: data?.public_message || null,
    };
    return cache;
  } catch (err) {
    console.error('[incidentGate] unexpected', err.message);
    cache = { at: Date.now(), active: false, message: null };
    return cache;
  }
}

async function isIncidentActive() {
  if (Date.now() - cache.at < TTL_MS) return cache.active;
  const next = await refreshIncidentStatus();
  return next.active;
}

function invalidateIncidentGate() {
  cache = { at: 0, active: false, message: null };
}

function setIncidentGateActive(active, message = null) {
  cache = { at: Date.now(), active: Boolean(active), message: message || null };
}

module.exports = {
  isIncidentActive,
  invalidateIncidentGate,
  setIncidentGateActive,
  refreshIncidentStatus,
};
