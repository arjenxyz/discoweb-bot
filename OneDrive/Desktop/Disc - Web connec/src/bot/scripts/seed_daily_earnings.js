#!/usr/bin/env node
// Quick script to insert test rows into daily_earnings
const path = require('path');
const { supabase } = require('../modules/database');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node seed_daily_earnings.js <guildId> <userId> <amount> [source]');
    process.exit(1);
  }

  const [guildId, userId, amountArg, sourceArg] = args;
  const amount = Number(amountArg);
  const source = sourceArg === 'voice' ? 'voice' : 'message';

  if (!guildId || !userId || isNaN(amount) || amount <= 0) {
    console.error('Invalid arguments');
    process.exit(2);
  }

  try {
    const earningDate = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from('daily_earnings').insert({
      guild_id: guildId,
      user_id: userId,
      source,
      earning_date: earningDate,
      amount: Number(amount.toFixed ? amount.toFixed(2) : amount),
      metadata: {},
    });

    if (error) {
      console.error('Insert error:', error);
      process.exit(3);
    }

    console.log('Inserted:', data);
    process.exit(0);
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(4);
  }
}

main();
